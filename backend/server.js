import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5500';
const uploadDir = path.join(__dirname, 'uploads');
const recommenderScriptPath = path.join(__dirname, 'recommender_xgb.py');
const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
fs.mkdirSync(uploadDir, { recursive: true });

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'order_app',
    waitForConnections: true,
    connectionLimit: 10
});

const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
});
const upload = multer({ storage });

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, '../frontend/public')));

function dedupeStringArray(values) {
    const result = [];
    const seen = new Set();
    values.forEach(value => {
        const text = String(value || '').trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(text);
    });
    return result;
}

function parseSpecs(value) {
    if (!value) return ['标准'];
    if (Array.isArray(value)) return value.length ? value : ['标准'];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.length ? parsed : ['标准'];
    } catch {
        const items = String(value)
            .split('\n')
            .map(item => item.trim())
            .filter(Boolean);
        return items.length ? items : ['标准'];
    }
}

function parseTagList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return dedupeStringArray(value);
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return [];
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return dedupeStringArray(parsed);
            }
        } catch {
            // ignore json parsing error and try plain text split
        }

        return dedupeStringArray(
            text
                .split(/[\n,，、|/]+/)
                .map(item => item.trim())
                .filter(Boolean)
        );
    }

    return [];
}

function formatOrderNo() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const prefix = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `ORD${prefix}${random}`;
}

function normalizeValue(value, min, max) {
    const num = Number(value || 0);
    if (max === min) {
        return max === 0 ? 0 : 1;
    }
    return (num - min) / (max - min);
}

async function getCartByToken(cartToken) {
    const [rows] = await pool.query(
        'SELECT * FROM carts WHERE cart_token = ? LIMIT 1',
        [cartToken]
    );
    return rows[0] || null;
}

async function getOpenCartByToken(cartToken) {
    const [rows] = await pool.query(
        'SELECT * FROM carts WHERE cart_token = ? AND status = ? LIMIT 1',
        [cartToken, 'open']
    );
    return rows[0] || null;
}

async function getCartItemsByCartId(cartId, connection = pool) {
    const [items] = await connection.query(
        `SELECT ci.id, ci.spec_name AS specName, ci.quantity, ci.unit_price AS unitPrice,
                d.id AS dishId, d.name AS dishName, d.image_url AS imageUrl,
                d.flavor_tags_json AS flavorTagsJson, d.ingredient_tags_json AS ingredientTagsJson
         FROM cart_items ci
         INNER JOIN dishes d ON d.id = ci.dish_id
         WHERE ci.cart_id = ?
         ORDER BY ci.id ASC`,
        [cartId]
    );
    return items;
}

function buildCartSummary(items) {
    const subtotal = items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
    const deliveryFee = subtotal > 0 ? 5 : 0;
    return {
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee
    };
}

async function getCartPayload(cartToken) {
    const cart = await getOpenCartByToken(cartToken);
    if (!cart) {
        return { items: [], summary: { subtotal: 0, deliveryFee: 0, total: 0 } };
    }

    const items = await getCartItemsByCartId(cart.id);
    return {
        items,
        summary: buildCartSummary(items)
    };
}

async function getAllDishesFlat(connection = pool) {
    const [rows] = await connection.query(
        `SELECT d.*, c.name AS category_name
         FROM dishes d
         LEFT JOIN categories c ON c.id = d.category_id
         ORDER BY d.category_id ASC, d.id ASC`
    );

    return rows.map(dish => ({
        id: Number(dish.id),
        categoryId: Number(dish.category_id),
        categoryName: dish.category_name || '',
        name: dish.name,
        description: dish.description,
        price: Number(dish.price),
        imageUrl: dish.image_url,
        sales: Number(dish.sales || 0),
        goodReviewCount: Number(dish.good_review_count || 0),
        badReviewCount: Number(dish.bad_review_count || 0),
        rating: Number(dish.rating || 0),
        specs: parseSpecs(dish.specs_json),
        flavorTags: parseTagList(dish.flavor_tags_json),
        ingredientTags: parseTagList(dish.ingredient_tags_json)
    }));
}

async function getRecentRecommendationHistory(limit = 20, connection = pool) {
    const [orders] = await connection.query(
        `SELECT id, checked_out_at AS checkedOutAt
         FROM checkout_history
         ORDER BY checked_out_at DESC, id DESC
         LIMIT ?`,
        [limit]
    );

    if (!orders.length) {
        return [];
    }

    const orderIndexMap = new Map(orders.map((order, index) => [Number(order.id), index]));
    const orderIds = orders.map(order => order.id);

    const [rows] = await connection.query(
        `SELECT history_id AS historyId, dish_id AS dishId, dish_name AS dishName,
                quantity, flavor_tags_json AS flavorTagsJson, ingredient_tags_json AS ingredientTagsJson
         FROM checkout_history_items
         WHERE history_id IN (?)
         ORDER BY history_id DESC, id ASC`,
        [orderIds]
    );

    return rows.map(item => ({
        historyId: Number(item.historyId),
        dishId: item.dishId == null ? null : Number(item.dishId),
        dishName: item.dishName,
        quantity: Number(item.quantity || 1),
        orderIndex: orderIndexMap.get(Number(item.historyId)) ?? limit,
        flavorTags: parseTagList(item.flavorTagsJson),
        ingredientTags: parseTagList(item.ingredientTagsJson)
    }));
}

function buildTagPreferenceFallback(historyItems, dishes) {
    const tagWeights = new Map();

    historyItems.forEach(item => {
        const recencyWeight = Math.max(1, 20 - Number(item.orderIndex || 0));
        const quantityWeight = Math.max(1, Number(item.quantity || 1));
        const weight = recencyWeight * quantityWeight;
        const tags = [...parseTagList(item.flavorTags), ...parseTagList(item.ingredientTags)];
        tags.forEach(tag => {
            const key = tag.toLowerCase();
            tagWeights.set(key, (tagWeights.get(key) || 0) + weight);
        });
    });

    const rawDishScoreMap = new Map();
    dishes.forEach(dish => {
        const tags = [...parseTagList(dish.flavorTags), ...parseTagList(dish.ingredientTags)];
        if (!tags.length) {
            rawDishScoreMap.set(Number(dish.id), 0);
            return;
        }

        const total = tags.reduce((sum, tag) => sum + (tagWeights.get(tag.toLowerCase()) || 0), 0);
        rawDishScoreMap.set(Number(dish.id), total / tags.length);
    });

    const values = Array.from(rawDishScoreMap.values());
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    const normalized = new Map();
    rawDishScoreMap.forEach((value, dishId) => {
        normalized.set(dishId, normalizeValue(value, min, max));
    });
    return normalized;
}

function rankDishesWithWeights(dishes, preferenceScores, limit = 6) {
    const salesValues = dishes.map(d => Number(d.sales || 0));
    const ratingValues = dishes.map(d => Number(d.rating || 0));
    const totalReviewValues = dishes.map(d => Number(d.goodReviewCount || 0) + Number(d.badReviewCount || 0));

    const minSales = salesValues.length ? Math.min(...salesValues) : 0;
    const maxSales = salesValues.length ? Math.max(...salesValues) : 0;
    const minRating = ratingValues.length ? Math.min(...ratingValues) : 0;
    const maxRating = ratingValues.length ? Math.max(...ratingValues) : 0;
    const minTotalReviews = totalReviewValues.length ? Math.min(...totalReviewValues) : 0;
    const maxTotalReviews = totalReviewValues.length ? Math.max(...totalReviewValues) : 0;

    return dishes
        .map(dish => {
            const preferenceMatch = Number(preferenceScores.get(Number(dish.id)) || 0);
            const salesScore = normalizeValue(dish.sales, minSales, maxSales);
            const totalReviews = Number(dish.goodReviewCount || 0) + Number(dish.badReviewCount || 0);
            const positiveRatio = totalReviews > 0 ? Number(dish.goodReviewCount || 0) / totalReviews : 0;
            const reviewVolumeScore = normalizeValue(totalReviews, minTotalReviews, maxTotalReviews);
            const reviewScore = positiveRatio * reviewVolumeScore;
            const ratingScore = normalizeValue(dish.rating, minRating, maxRating);
            const finalScore =
                0.5 * preferenceMatch +
                0.2 * salesScore +
                0.15 * reviewScore +
                0.15 * ratingScore;

            return {
                ...dish,
                totalReviews,
                positiveRatio,
                preferenceMatch,
                salesScore,
                reviewScore,
                ratingScore,
                finalScore
            };
        })
        .sort((a, b) => {
            if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
            if (b.sales !== a.sales) return b.sales - a.sales;
            return Number(a.price || 0) - Number(b.price || 0);
        })
        .slice(0, limit);
}

function runRecommenderModel(payload) {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [recommenderScriptPath], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            reject(error);
        });

        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `推荐模型执行失败，退出码 ${code}`));
                return;
            }

            try {
                resolve(JSON.parse(stdout || '{}'));
            } catch (error) {
                reject(new Error(`推荐模型返回结果无法解析: ${error.message}`));
            }
        });

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

async function buildRecommendationResponse(limit = 6) {
    const dishes = await getAllDishesFlat();
    if (!dishes.length) {
        return {
            items: [],
            modelMode: 'empty_menu',
            historyCount: 0
        };
    }

    const historyItems = await getRecentRecommendationHistory(20);
    if (!historyItems.length) {
        return {
            items: rankDishesWithWeights(dishes, new Map(), limit),
            modelMode: 'cold_start',
            historyCount: 0
        };
    }

    const payload = {
        dishes: dishes.map(dish => ({
            id: dish.id,
            name: dish.name,
            flavorTags: dish.flavorTags,
            ingredientTags: dish.ingredientTags
        })),
        historyItems: historyItems.map(item => ({
            dishId: item.dishId,
            quantity: item.quantity,
            orderIndex: item.orderIndex,
            flavorTags: item.flavorTags,
            ingredientTags: item.ingredientTags
        }))
    };

    let preferenceScores;
    let modelMode = 'xgboost';

    try {
        const result = await runRecommenderModel(payload);
        preferenceScores = new Map(
            Object.entries(result.preferenceScores || {}).map(([dishId, score]) => [Number(dishId), Number(score || 0)])
        );
        modelMode = result.mode || 'xgboost';
    } catch (error) {
        console.error('XGBoost 推荐模型执行失败，已回退到标签频率偏好：', error.message);
        preferenceScores = buildTagPreferenceFallback(historyItems, dishes);
        modelMode = 'fallback_tag_frequency';
    }

    return {
        items: rankDishesWithWeights(dishes, preferenceScores, limit),
        modelMode,
        historyCount: historyItems.length
    };
}

app.get('/api/menu', async (_, res) => {
    try {
        const [[store]] = await pool.query('SELECT * FROM stores ORDER BY id ASC LIMIT 1');
        const [categories] = await pool.query(
            'SELECT * FROM categories ORDER BY display_order ASC, id ASC'
        );
        const dishes = await getAllDishesFlat();

        const categoryMap = new Map(
            categories.map(category => [category.id, {
                id: category.id,
                name: category.name,
                icon: category.icon,
                description: category.description,
                color: category.color,
                displayOrder: category.display_order,
                dishes: []
            }])
        );

        for (const dish of dishes) {
            const target = categoryMap.get(dish.categoryId);
            if (!target) continue;
            target.dishes.push({
                id: dish.id,
                categoryId: dish.categoryId,
                name: dish.name,
                description: dish.description,
                price: dish.price,
                imageUrl: dish.imageUrl,
                sales: dish.sales,
                goodReviewCount: dish.goodReviewCount,
                badReviewCount: dish.badReviewCount,
                rating: dish.rating,
                specs: dish.specs,
                flavorTags: dish.flavorTags,
                ingredientTags: dish.ingredientTags
            });
        }

        res.json({
            store: {
                id: store?.id || 1,
                name: store?.name || 'Online Order OvO',
                rating: Number(store?.rating || 4.8),
                reviewCount: store?.review_count || 2500,
                distanceKm: Number(store?.distance_km || 3.2),
                deliveryMinutes: store?.delivery_minutes || 30
            },
            categories: Array.from(categoryMap.values())
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/recommendations', async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
        const result = await buildRecommendationResponse(limit);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/categories', async (_, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, icon, description, color, display_order AS displayOrder FROM categories ORDER BY display_order ASC, id ASC'
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/categories', async (req, res) => {
    try {
        const { name, icon, description = '', color = '#ff9800', displayOrder = null } = req.body;
        if (!name) {
            return res.status(400).json({ message: '品类名称不能为空' });
        }
        const [result] = await pool.query(
            `INSERT INTO categories (name, icon, description, color, display_order)
             VALUES (?, ?, ?, ?, COALESCE(?, 999))`,
            [name, icon || '🍽️', description, color, displayOrder]
        );
        res.status(201).json({ id: result.insertId, message: '分类创建成功' });
    } catch (error) {
        if (String(error.message).includes('Duplicate')) {
            return res.status(409).json({ message: '分类名称已存在' });
        }
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/categories/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
        res.json({ message: '分类删除成功' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/dishes', upload.single('image'), async (req, res) => {
    try {
        const {
            name,
            categoryId,
            price,
            description = '',
            sales = 0,
            goodReviewCount = 0,
            badReviewCount = 0,
            rating = 0,
            specs = '[]',
            flavorTags = '[]',
            ingredientTags = '[]'
        } = req.body;

        if (!name || !categoryId || price === undefined) {
            return res.status(400).json({ message: '商品名称、分类和价格不能为空' });
        }

        const numericRating = Number(rating);
        if (!Number.isFinite(numericRating) || numericRating < 0 || numericRating > 5) {
            return res.status(400).json({ message: '评分必须在 0 到 5 之间' });
        }

        const imageUrl = req.file
            ? `/uploads/${req.file.filename}`
            : `https://via.placeholder.com/200x150?text=${encodeURIComponent(name)}`;
        const specsJson = JSON.stringify(parseSpecs(specs));
        const flavorTagsJson = JSON.stringify(parseTagList(flavorTags));
        const ingredientTagsJson = JSON.stringify(parseTagList(ingredientTags));

        const [result] = await pool.query(
            `INSERT INTO dishes (
                category_id, name, description, price, image_url, sales,
                good_review_count, bad_review_count, rating, specs_json,
                flavor_tags_json, ingredient_tags_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                categoryId,
                name,
                description,
                price,
                imageUrl,
                Number(sales || 0),
                Number(goodReviewCount || 0),
                Number(badReviewCount || 0),
                numericRating,
                specsJson,
                flavorTagsJson,
                ingredientTagsJson
            ]
        );
        res.status(201).json({ id: result.insertId, message: '商品创建成功' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/dishes/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM dishes WHERE id = ?', [req.params.id]);
        res.json({ message: '商品删除成功' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/cart/create', async (_, res) => {
    try {
        const cartToken = uuidv4();
        await pool.query('INSERT INTO carts (cart_token, status) VALUES (?, ?)', [cartToken, 'open']);
        res.status(201).json({ cartToken });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/cart', async (req, res) => {
    try {
        const { cartToken } = req.query;
        if (!cartToken) {
            return res.json({ items: [], summary: { subtotal: 0, deliveryFee: 0, total: 0 } });
        }
        const payload = await getCartPayload(cartToken);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/cart/items', async (req, res) => {
    try {
        const { cartToken, dishId, specName = '标准', quantity = 1 } = req.body;
        if (!cartToken || !dishId) {
            return res.status(400).json({ message: 'cartToken 和 dishId 不能为空' });
        }

        let cart = await getOpenCartByToken(cartToken);
        if (!cart) {
            await pool.query('INSERT INTO carts (cart_token, status) VALUES (?, ?)', [cartToken, 'open']);
            cart = await getOpenCartByToken(cartToken);
        }

        const [[dish]] = await pool.query('SELECT id, price FROM dishes WHERE id = ? LIMIT 1', [dishId]);
        if (!dish) {
            return res.status(404).json({ message: '商品不存在' });
        }

        const [[existing]] = await pool.query(
            'SELECT id, quantity FROM cart_items WHERE cart_id = ? AND dish_id = ? AND spec_name = ? LIMIT 1',
            [cart.id, dishId, specName]
        );

        if (existing) {
            await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [existing.quantity + Number(quantity), existing.id]);
        } else {
            await pool.query(
                'INSERT INTO cart_items (cart_id, dish_id, spec_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
                [cart.id, dishId, specName, Number(quantity), dish.price]
            );
        }

        res.status(201).json(await getCartPayload(cartToken));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.patch('/api/cart/items/:id', async (req, res) => {
    try {
        const quantity = Number(req.body.quantity);
        if (!Number.isFinite(quantity)) {
            return res.status(400).json({ message: 'quantity 非法' });
        }
        if (quantity <= 0) {
            await pool.query('DELETE FROM cart_items WHERE id = ?', [req.params.id]);
            return res.json({ message: '购物车项已删除' });
        }
        await pool.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [quantity, req.params.id]);
        res.json({ message: '购物车已更新' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/cart/items/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cart_items WHERE id = ?', [req.params.id]);
        res.json({ message: '购物车项已删除' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/cart/checkout', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { cartToken } = req.body;
        if (!cartToken) {
            connection.release();
            return res.status(400).json({ message: 'cartToken 不能为空' });
        }

        const [cartRows] = await connection.query(
            'SELECT * FROM carts WHERE cart_token = ? AND status = ? LIMIT 1',
            [cartToken, 'open']
        );
        const cart = cartRows[0] || null;
        if (!cart) {
            connection.release();
            return res.status(404).json({ message: '未找到可结算的购物车' });
        }

        const items = await getCartItemsByCartId(cart.id, connection);
        if (!items.length) {
            connection.release();
            return res.status(400).json({ message: '购物车为空，无法结算' });
        }

        const summary = buildCartSummary(items);
        const itemCount = items.reduce((sum, item) => sum + Number(item.quantity), 0);
        const orderNo = formatOrderNo();

        await connection.beginTransaction();

        const [historyResult] = await connection.query(
            `INSERT INTO checkout_history
                (order_no, cart_id, cart_token, item_count, subtotal, delivery_fee, total)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [orderNo, cart.id, cart.cart_token, itemCount, summary.subtotal, summary.deliveryFee, summary.total]
        );

        const historyId = historyResult.insertId;
        for (const item of items) {
            await connection.query(
                `INSERT INTO checkout_history_items
                    (
                        history_id, dish_id, dish_name, spec_name, quantity, unit_price,
                        line_total, image_url, flavor_tags_json, ingredient_tags_json
                    )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    historyId,
                    item.dishId,
                    item.dishName,
                    item.specName,
                    item.quantity,
                    Number(item.unitPrice),
                    Number(item.unitPrice) * Number(item.quantity),
                    item.imageUrl || null,
                    JSON.stringify(parseTagList(item.flavorTagsJson)),
                    JSON.stringify(parseTagList(item.ingredientTagsJson))
                ]
            );
        }

        await connection.query(
            'UPDATE carts SET status = ? WHERE id = ? AND status = ?',
            ['checked_out', cart.id, 'open']
        );

        await connection.commit();
        connection.release();

        res.json({
            message: '订单提交成功',
            orderNo,
            summary
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch {
            // ignore rollback errors
        }
        connection.release();
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/checkout-history', async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
        const [orders] = await pool.query(
            `SELECT id, order_no AS orderNo, cart_id AS cartId, cart_token AS cartToken,
                    item_count AS itemCount, subtotal, delivery_fee AS deliveryFee,
                    total, checked_out_at AS checkedOutAt
             FROM checkout_history
             ORDER BY id DESC
             LIMIT ?`,
            [limit]
        );

        const orderIds = orders.map(order => order.id);
        let items = [];
        if (orderIds.length) {
            const [rows] = await pool.query(
                `SELECT history_id AS historyId, dish_id AS dishId, dish_name AS dishName,
                        spec_name AS specName, quantity, unit_price AS unitPrice,
                        line_total AS lineTotal, image_url AS imageUrl,
                        flavor_tags_json AS flavorTagsJson,
                        ingredient_tags_json AS ingredientTagsJson
                 FROM checkout_history_items
                 WHERE history_id IN (?)
                 ORDER BY id ASC`,
                [orderIds]
            );
            items = rows.map(item => ({
                ...item,
                dishId: item.dishId == null ? null : Number(item.dishId),
                flavorTags: parseTagList(item.flavorTagsJson),
                ingredientTags: parseTagList(item.ingredientTagsJson)
            }));
        }

        const itemMap = new Map();
        items.forEach(item => {
            if (!itemMap.has(item.historyId)) itemMap.set(item.historyId, []);
            itemMap.get(item.historyId).push(item);
        });

        res.json(orders.map(order => ({
            ...order,
            subtotal: Number(order.subtotal),
            deliveryFee: Number(order.deliveryFee),
            total: Number(order.total),
            items: itemMap.get(order.id) || []
        })));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('*', (_, res) => {
    res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
