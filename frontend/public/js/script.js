const RECOMMEND_CATEGORY_ID = 'recommend';
const RECOMMEND_CATEGORY_META = {
    id: RECOMMEND_CATEGORY_ID,
    name: '推荐',
    icon: '✨',
    description: '个性化推荐占位区'
};

const state = {
    store: null,
    categories: [],
    recommendedDishes: [],
    cartToken: null,
    cart: { items: [], summary: { subtotal: 0, deliveryFee: 0, total: 0 } },
    orderHistory: [],
    currentDish: null,
    currentSpecSelection: null,
    isScrolling: false,
    scrollTimeout: null,
    uploadedImageFile: null,
    recommendationMeta: null,
    scrollSyncInitialized: false,
    currentActiveCategoryId: RECOMMEND_CATEGORY_ID
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await ensureCartToken();
        await Promise.all([loadMenu(), loadCart()]);
        setupScrollSync();
    } catch (error) {
        showNotification(error.message || '初始化失败');
    }
});

async function ensureCartToken() {
    let cartToken = localStorage.getItem('cartToken');
    if (!cartToken) {
        const data = await api.createCart();
        cartToken = data.cartToken;
        localStorage.setItem('cartToken', cartToken);
    }
    state.cartToken = cartToken;
}

async function loadMenu() {
    const data = await api.getMenu();
    state.store = data.store;
    state.categories = Array.isArray(data.categories) ? data.categories : [];
    state.recommendedDishes = await loadRecommendedDishes();
    renderStoreInfo();
    renderRecommendationMeta();
    renderCategories();
    renderCategoryOptions();
    renderAllDishes();
    updateActiveCategory(RECOMMEND_CATEGORY_ID);
    requestAnimationFrame(() => updateActiveCategoryByScroll());
}

function getDisplayCategories() {
    return [
        {
            ...RECOMMEND_CATEGORY_META,
            dishes: state.recommendedDishes
        },
        ...state.categories
    ];
}

function normalizeDishPayload(dish) {
    return {
        ...dish,
        categoryId: Number(dish.categoryId || 0),
        price: Number(dish.price || 0),
        sales: Number(dish.sales || 0),
        goodReviewCount: Number(dish.goodReviewCount || 0),
        badReviewCount: Number(dish.badReviewCount || 0),
        rating: Number(dish.rating || 0),
        specs: Array.isArray(dish.specs) && dish.specs.length ? dish.specs : ['标准'],
        flavorTags: Array.isArray(dish.flavorTags) ? dish.flavorTags : [],
        ingredientTags: Array.isArray(dish.ingredientTags) ? dish.ingredientTags : []
    };
}

async function loadRecommendedDishes() {
    try {
        const response = await api.getRecommendations(6);
        state.recommendationMeta = response;
        const items = Array.isArray(response.items) ? response.items.map(normalizeDishPayload) : [];
        if (items.length) {
            console.log('推荐接口模式：', response.modelMode || 'unknown');
            return items;
        }
    } catch (error) {
        console.error('后端推荐接口失败，已回退到前端推荐：', error);
    }

    return buildRecommendedDishes(state.categories);
}

async function buildRecommendedDishes(categories) {
    const allDishes = categories.flatMap(category =>
        (category.dishes || []).map(dish => ({
            ...dish,
            categoryId: dish.categoryId ?? category.id,
            categoryName: category.name,
            sales: Number(dish.sales || 0),
            goodReviewCount: Number(dish.goodReviewCount || 0),
            badReviewCount: Number(dish.badReviewCount || 0),
            rating: Number(dish.rating || 0)
        }))
    );

    if (!allDishes.length) {
        return [];
    }

    try {
        const orderHistory = await api.getCheckoutHistory(20);
        state.orderHistory = Array.isArray(orderHistory) ? orderHistory : [];

        const dishToCategoryMap = new Map();
        allDishes.forEach(dish => {
            dishToCategoryMap.set(Number(dish.id), dish.categoryId);
        });

        const rawCategoryPreferenceMap = new Map();

        state.orderHistory.forEach((order, orderIndex) => {
            const recencyWeight = Math.max(1, 20 - orderIndex);
            const items = Array.isArray(order.items) ? order.items : [];

            items.forEach(item => {
                const dishId = Number(item.dishId);
                const categoryId = dishToCategoryMap.get(dishId);
                if (!categoryId) return;

                const quantity = Number(item.quantity || 1);
                const oldScore = rawCategoryPreferenceMap.get(categoryId) || 0;
                rawCategoryPreferenceMap.set(categoryId, oldScore + recencyWeight * quantity);
            });
        });

        const categoryPreferenceMap = normalizeMap(rawCategoryPreferenceMap);

        const salesValues = allDishes.map(d => Number(d.sales || 0));
        const ratingValues = allDishes.map(d => Number(d.rating || 0));
        const totalReviewValues = allDishes.map(d => Number(d.goodReviewCount || 0) + Number(d.badReviewCount || 0));

        const minSales = Math.min(...salesValues);
        const maxSales = Math.max(...salesValues);
        const minRating = Math.min(...ratingValues);
        const maxRating = Math.max(...ratingValues);
        const minTotalReviews = Math.min(...totalReviewValues);
        const maxTotalReviews = Math.max(...totalReviewValues);

        const ranked = allDishes.map(dish => {
            const preferenceMatch = categoryPreferenceMap.get(dish.categoryId) || 0;
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
        });

        return ranked
            .sort((a, b) => {
                if (b.finalScore !== a.finalScore) {
                    return b.finalScore - a.finalScore;
                }
                if (b.sales !== a.sales) {
                    return b.sales - a.sales;
                }
                return Number(a.price || 0) - Number(b.price || 0);
            })
            .slice(0, 6);
    } catch (error) {
        console.error('推荐算法执行失败，已回退到销量排序：', error);

        return allDishes
            .sort((a, b) => Number(b.sales || 0) - Number(a.sales || 0))
            .slice(0, 6);
    }
}

function normalizeMap(scoreMap) {
    const result = new Map();
    if (!scoreMap || scoreMap.size === 0) {
        return result;
    }

    const values = Array.from(scoreMap.values());
    const min = Math.min(...values);
    const max = Math.max(...values);

    scoreMap.forEach((value, key) => {
        result.set(key, normalizeValue(value, min, max));
    });

    return result;
}

function normalizeValue(value, min, max) {
    const num = Number(value || 0);
    if (max === min) {
        return max === 0 ? 0 : 1;
    }
    return (num - min) / (max - min);
}

function renderStoreInfo() {
    if (!state.store) return;
    document.getElementById('shopName').textContent = state.store.name;
    document.getElementById('shopRating').textContent = `⭐ ${state.store.rating.toFixed(1)} (${state.store.reviewCount}+评价)`;
    document.getElementById('shopDelivery').textContent = `📍 ${state.store.distanceKm}km | 🚚 ${state.store.deliveryMinutes}分钟`;
}

function renderRecommendationMeta() {
    const modeEl = document.getElementById('recommendationModeLabel');
    const summaryEl = document.getElementById('recommendationSummary');
    const historyEl = document.getElementById('recommendationHistoryLabel');

    const mode = state.recommendationMeta?.modelMode || 'front_fallback';
    const historyCount = Number(state.recommendationMeta?.historyCount || state.orderHistory?.length || 0);

    if (modeEl) {
        const modeTextMap = {
            xgboost: 'XGBoost 偏好学习',
            logistic_fallback: 'Logistic 偏好回退',
            tag_frequency_fallback: '标签频率回退',
            front_fallback: '前端加权回退'
        };
        modeEl.textContent = modeTextMap[mode] || `推荐模式：${mode}`;
    }

    if (summaryEl) {
        summaryEl.textContent = `当前推荐模式：${mode}，系统会综合最近订单、口味标签、食材标签、销量、评价和评分进行加权排序。`;
    }

    if (historyEl) {
        historyEl.textContent = `历史订单 ${historyCount} 条`;
    }
}

function renderCategoryOptions() {
    const select = document.getElementById('productCategory');
    select.innerHTML = '<option value="">请选择分类</option>';
    state.categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category.id;
        option.textContent = `${category.icon || '🍽️'} ${category.name}`;
        select.appendChild(option);
    });
}

function renderCategories() {
    const nav = document.getElementById('categoriesNav');
    const displayCategories = getDisplayCategories();
    nav.innerHTML = '';

    displayCategories.forEach((category, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `category-item${index === 0 ? ' active' : ''}`;
        item.id = `nav-${category.id}`;
        item.onclick = () => scrollToCategory(category.id);
        item.innerHTML = `
            <span class="category-icon">${category.icon || '🍽️'}</span>
            <span class="category-name">${category.name}</span>
            <span class="category-count">${(category.dishes || []).length} 款</span>
        `;
        nav.appendChild(item);
    });
}

function renderAllDishes() {
    const container = document.getElementById('dishesContainer');
    const displayCategories = getDisplayCategories();
    container.innerHTML = '';

    if (displayCategories.every(category => !(category.dishes || []).length) && state.categories.length === 0) {
        container.innerHTML = '<div class="empty-cart" style="padding:24px;">暂无菜品，请先添加品类和商品</div>';
        return;
    }

    displayCategories.forEach(category => {
        const section = document.createElement('section');
        section.className = 'menu-section';
        section.id = `section-${category.id}`;
        section.dataset.categoryId = String(category.id);

        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `${category.icon || '🍽️'} ${category.name}`;

        const grid = document.createElement('div');
        grid.className = 'dishes-grid';
        grid.dataset.categoryId = String(category.id);

        if (!(category.dishes || []).length) {
            const empty = document.createElement('div');
            empty.className = 'empty-cart empty-section';
            empty.textContent = category.id === RECOMMEND_CATEGORY_ID
                ? '推荐区当前暂无结果，继续下单或添加更多带标签的菜品后会更容易生成个性化排序。'
                : '该分类下暂无商品';
            grid.appendChild(empty);
        } else {
            category.dishes.forEach(dish => {
                const card = createDishCard(dish, category);
                if (category.id === RECOMMEND_CATEGORY_ID) {
                    card.classList.add('recommended-card');
                }
                grid.appendChild(card);
            });
        }

        section.appendChild(header);
        section.appendChild(grid);
        container.appendChild(section);
    });
}

function createDishCard(dish, category) {
    const card = document.createElement('div');
    card.className = 'dish-card';
    card.id = `dish-${dish.id}`;
    card.dataset.categoryId = String(category.id);
    card.onclick = () => openDishModal(dish);

    const specs = Array.isArray(dish.specs) && dish.specs.length ? dish.specs : ['标准'];
    dish.specs = specs;

    const deleteButton = category.id === RECOMMEND_CATEGORY_ID
        ? ''
        : `<button class="dish-delete-btn" onclick="event.stopPropagation(); deleteDish(${dish.id})">🗑️</button>`;

    const goodReviewCount = Number(dish.goodReviewCount || 0);
    const badReviewCount = Number(dish.badReviewCount || 0);
    const rating = Number(dish.rating || 0);
    const totalReviews = goodReviewCount + badReviewCount;
    const highlightTags = [
        ...(Array.isArray(dish.flavorTags) ? dish.flavorTags.slice(0, 2) : []),
        ...(Array.isArray(dish.ingredientTags) ? dish.ingredientTags.slice(0, 2) : [])
    ].filter(Boolean);

    card.innerHTML = `
        <div class="dish-media">
            <img src="${dish.imageUrl}" alt="${dish.name}" class="dish-image" onerror="this.src='https://via.placeholder.com/320x320?text=${encodeURIComponent(dish.name)}'">
            ${deleteButton}
            ${category.id === RECOMMEND_CATEGORY_ID ? '<span class="dish-badge">AI 推荐</span>' : ''}
        </div>
        <div class="dish-info">
            <div>
                <div class="dish-name">${dish.name}</div>
                <div class="dish-description">${dish.description || '暂无描述'}</div>
            </div>

            <div class="dish-meta-row">
                <span class="dish-meta-pill">${dish.sales} 已售</span>
                <span class="dish-meta-pill">👍 ${goodReviewCount}</span>
                <span class="dish-meta-pill">👎 ${badReviewCount}</span>
                <span class="dish-meta-pill">⭐ ${rating.toFixed(1)} · ${totalReviews}评</span>
            </div>

            <div class="dish-tags">
                ${highlightTags.length ? highlightTags.map(tag => `<span class="dish-chip">${tag}</span>`).join('') : '<span class="dish-chip">标准</span>'}
            </div>

            <div class="dish-footer">
                <div>
                    <span class="dish-price">¥${Number(dish.price).toFixed(2)}</span>
                    <span class="dish-sub-price">${specs.join(' / ')}</span>
                </div>
                <button class="add-btn" onclick="event.stopPropagation(); quickAddToCart(${dish.id})">+</button>
            </div>
        </div>
    `;

    return card;
}

async function openAddProductModal() {
    if (!state.categories.length) {
        showNotification('请先添加品类');
        return;
    }
    document.getElementById('addProductForm').reset();
    state.uploadedImageFile = null;
    renderCategoryOptions();
    document.getElementById('imagePreview').innerHTML = `
        <span class="upload-icon">📷</span>
        <span class="upload-text">点击上传图片</span>
    `;
    document.getElementById('imagePreview').classList.remove('has-image');
    document.getElementById('addProductModal').classList.add('active');
}

function closeAddProductModal() {
    document.getElementById('addProductModal').classList.remove('active');
    state.uploadedImageFile = null;
}

function previewImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    state.uploadedImageFile = file;
    const reader = new FileReader();
    reader.onload = e => {
        const preview = document.getElementById('imagePreview');
        preview.innerHTML = `<img src="${e.target.result}" alt="预览图片">`;
        preview.classList.add('has-image');
    };
    reader.readAsDataURL(file);
}

async function handleAddProduct(event) {
    event.preventDefault();
    const name = document.getElementById('productName').value.trim();
    const categoryId = document.getElementById('productCategory').value;
    const price = document.getElementById('productPrice').value;
    const description = document.getElementById('productDescription').value.trim();
    const specsInput = document.getElementById('productSpecs').value.trim();
    const sales = document.getElementById('productSales').value || '0';
    const goodReviewCount = document.getElementById('productGoodReviewCount').value || '0';
    const badReviewCount = document.getElementById('productBadReviewCount').value || '0';
    const rating = document.getElementById('productRating').value || '0';
    const flavorTagsInput = document.getElementById('productFlavorTags').value.trim();
    const ingredientTagsInput = document.getElementById('productIngredientTags').value.trim();

    if (!name || !categoryId || price === '') {
        showNotification('请填写完整的商品信息');
        return;
    }

    if (Number(rating) < 0 || Number(rating) > 5) {
        showNotification('评分必须在 0 到 5 之间');
        return;
    }

    const specs = specsInput
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

    const formData = new FormData();
    formData.append('name', name);
    formData.append('categoryId', categoryId);
    formData.append('price', price);
    formData.append('description', description);
    formData.append('sales', sales);
    formData.append('goodReviewCount', goodReviewCount);
    formData.append('badReviewCount', badReviewCount);
    formData.append('rating', rating);
    formData.append('specs', JSON.stringify(specs.length ? specs : ['标准']));
    formData.append('flavorTags', JSON.stringify(flavorTagsInput.split(/[,，、\n|/]+/).map(s => s.trim()).filter(Boolean)));
    formData.append('ingredientTags', JSON.stringify(ingredientTagsInput.split(/[,，、\n|/]+/).map(s => s.trim()).filter(Boolean)));
    if (state.uploadedImageFile) {
        formData.append('image', state.uploadedImageFile);
    }

    try {
        await api.createDish(formData);
        closeAddProductModal();
        await loadMenu();
        showNotification('商品添加成功');
        scrollToCategory(categoryId);
    } catch (error) {
        showNotification(error.message || '商品添加失败');
    }
}

async function deleteDish(dishId) {
    if (!confirm('确定要删除这个商品吗？')) return;
    try {
        await api.deleteDish(dishId);
        await loadMenu();
        showNotification('商品已删除');
    } catch (error) {
        showNotification(error.message || '删除失败');
    }
}

function setupScrollSync() {
    if (state.scrollSyncInitialized) {
        return;
    }

    const menuContent = document.getElementById('menuContent');
    if (!menuContent) {
        return;
    }

    menuContent.addEventListener('scroll', () => {
        updateActiveCategoryByScroll();
    }, { passive: true });

    state.scrollSyncInitialized = true;
}

function updateActiveCategoryByScroll() {
    const menuContent = document.getElementById('menuContent');
    const sections = Array.from(menuContent?.querySelectorAll('.menu-section') || []).filter(section => section.style.display !== 'none');
    if (!menuContent || !sections.length) {
        return;
    }

    const anchor = menuContent.scrollTop + 96;
    let currentCategory = sections[0].dataset.categoryId;

    sections.forEach(section => {
        if (section.offsetTop <= anchor) {
            currentCategory = section.dataset.categoryId;
        }
    });

    updateActiveCategory(currentCategory);
}

function updateActiveCategory(categoryId) {
    state.currentActiveCategoryId = String(categoryId);
    document.querySelectorAll('.category-item').forEach(item => item.classList.remove('active'));
    const activeItem = document.getElementById(`nav-${categoryId}`);
    if (activeItem) {
        activeItem.classList.add('active');
        activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function scrollToCategory(categoryId) {
    const section = document.getElementById(`section-${categoryId}`);
    const menuContent = document.getElementById('menuContent');
    if (!section || !menuContent) return;

    updateActiveCategory(categoryId);
    menuContent.scrollTo({ top: Math.max(0, section.offsetTop - 8), behavior: 'smooth' });
}

function openDishModal(dish) {
    state.currentDish = dish;
    state.currentSpecSelection = (dish.specs && dish.specs[0]) || '标准';
    document.getElementById('modalImage').src = dish.imageUrl;
    document.getElementById('modalName').textContent = dish.name;
    document.getElementById('modalDescription').textContent = dish.description || '暂无描述';

    const goodReviewCount = Number(dish.goodReviewCount || 0);
    const badReviewCount = Number(dish.badReviewCount || 0);
    const totalReviewCount = goodReviewCount + badReviewCount;
    const rating = Number(dish.rating || 0);

    document.getElementById('modalGoodReviewCount').textContent = goodReviewCount;
    document.getElementById('modalBadReviewCount').textContent = badReviewCount;
    document.getElementById('modalRating').textContent = rating.toFixed(1);
    document.getElementById('modalTotalReviewCount').textContent = totalReviewCount;
    document.getElementById('modalPrice').textContent = `¥${Number(dish.price).toFixed(2)}`;
    document.getElementById('modalQuantity').value = 1;

    const specOptions = document.getElementById('specOptions');
    specOptions.innerHTML = '';
    dish.specs.forEach((spec, index) => {
        const btn = document.createElement('button');
        btn.className = `spec-option${index === 0 ? ' selected' : ''}`;
        btn.textContent = spec;
        btn.onclick = () => selectSpec(spec, dish.specs);
        specOptions.appendChild(btn);
    });

    document.getElementById('dishModal').classList.add('active');
}

function closeDishModal() {
    document.getElementById('dishModal').classList.remove('active');
    state.currentDish = null;
}

function selectSpec(spec, allSpecs) {
    state.currentSpecSelection = spec;
    document.querySelectorAll('.spec-option').forEach((btn, index) => {
        btn.classList.toggle('selected', allSpecs[index] === spec);
    });
}

function increaseQuantity() {
    const input = document.getElementById('modalQuantity');
    input.value = Math.min(99, parseInt(input.value, 10) + 1);
}

function decreaseQuantity() {
    const input = document.getElementById('modalQuantity');
    input.value = Math.max(1, parseInt(input.value, 10) - 1);
}

function findDishById(id) {
    for (const category of state.categories) {
        const dish = category.dishes.find(item => Number(item.id) === Number(id));
        if (dish) return dish;
    }
    return state.recommendedDishes.find(item => Number(item.id) === Number(id)) || null;
}

async function addToCart() {
    if (!state.currentDish) return;
    const quantity = parseInt(document.getElementById('modalQuantity').value, 10);
    try {
        await api.addCartItem({
            cartToken: state.cartToken,
            dishId: state.currentDish.id,
            specName: state.currentSpecSelection,
            quantity
        });
        await loadCart();
        closeDishModal();
        showNotification('已加入购物车');
    } catch (error) {
        showNotification(error.message || '加入购物车失败');
    }
}

async function quickAddToCart(dishId) {
    const dish = findDishById(dishId);
    if (!dish) return;
    try {
        await api.addCartItem({
            cartToken: state.cartToken,
            dishId: dish.id,
            specName: (dish.specs && dish.specs[0]) || '标准',
            quantity: 1
        });
        await loadCart();
        showNotification('已加入购物车');
    } catch (error) {
        showNotification(error.message || '加入购物车失败');
    }
}

async function loadCart() {
    state.cart = await api.getCart(state.cartToken);
    updateCartCount();
    updateCartSummary();
    if (document.getElementById('cartPanel').classList.contains('active')) {
        renderCartItems();
    }
}

function toggleCart() {
    document.getElementById('cartPanel').classList.toggle('active');
    renderCartItems();
    updateCartSummary();
}

function renderCartItems() {
    const container = document.getElementById('cartItems');
    const items = state.cart.items || [];
    if (!items.length) {
        container.innerHTML = '<p class="empty-cart">购物车为空</p>';
        return;
    }

    container.innerHTML = '';
    items.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = 'cart-item';
        itemEl.innerHTML = `
            <div>
                <div class="item-name">${item.dishName}</div>
                <div class="item-spec">${item.specName}</div>
            </div>
            <div class="item-price">¥${(Number(item.unitPrice) * item.quantity).toFixed(2)}</div>
            <div class="item-quantity">
                <button onclick="updateCartQuantity(${item.id}, ${item.quantity - 1})">-</button>
                <input type="number" value="${item.quantity}" min="1" max="99" readonly>
                <button onclick="updateCartQuantity(${item.id}, ${item.quantity + 1})">+</button>
            </div>
            <button class="item-remove" onclick="removeFromCart(${item.id})">✕</button>
        `;
        container.appendChild(itemEl);
    });
}

async function updateCartQuantity(itemId, quantity) {
    try {
        await api.updateCartItem(itemId, { quantity });
        await loadCart();
        renderCartItems();
        updateCartSummary();
    } catch (error) {
        showNotification(error.message || '更新数量失败');
    }
}

async function removeFromCart(itemId) {
    try {
        await api.removeCartItem(itemId);
        await loadCart();
        renderCartItems();
        updateCartSummary();
    } catch (error) {
        showNotification(error.message || '移除失败');
    }
}

function updateCartCount() {
    const total = (state.cart.items || []).reduce((sum, item) => sum + item.quantity, 0);
    const cartCountEl = document.getElementById('cartCount');
    const headerCartCountEl = document.getElementById('headerCartCount');
    if (cartCountEl) cartCountEl.textContent = total;
    if (headerCartCountEl) headerCartCountEl.textContent = total;
}

function updateCartSummary() {
    const summary = state.cart.summary || { subtotal: 0, deliveryFee: 0, total: 0 };
    document.getElementById('subtotal').textContent = `¥${Number(summary.subtotal).toFixed(2)}`;
    document.getElementById('deliveryFee').textContent = `¥${Number(summary.deliveryFee).toFixed(2)}`;
    document.getElementById('total').textContent = `¥${Number(summary.total).toFixed(2)}`;

    const bottomSubtotal = document.getElementById('bottomSubtotal');
    if (bottomSubtotal) {
        bottomSubtotal.textContent = `¥${Number(summary.total).toFixed(2)}`;
    }
}

function searchDishes() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    document.querySelectorAll('.dishes-grid').forEach(grid => {
        let visibleCount = 0;
        grid.querySelectorAll('.dish-card').forEach(card => {
            const name = card.querySelector('.dish-name')?.textContent.toLowerCase() || '';
            const description = card.querySelector('.dish-description')?.textContent.toLowerCase() || '';
            const matches = !query || name.includes(query) || description.includes(query);
            card.style.display = matches ? 'flex' : 'none';
            if (matches) visibleCount += 1;
        });

        const section = document.getElementById(`section-${grid.dataset.categoryId}`);
        if (section) {
            section.style.display = visibleCount > 0 || !query ? 'block' : 'none';
        }
        grid.style.display = visibleCount > 0 || !query ? 'grid' : 'none';
    });

    updateActiveCategoryByScroll();
}

async function checkout() {
    const items = state.cart.items || [];
    if (!items.length) {
        showNotification('购物车为空');
        return;
    }

    try {
        const result = await api.checkout({ cartToken: state.cartToken });
        const orderNoText = result.orderNo ? `，订单号 ${result.orderNo}` : '';
        showNotification(`订单提交成功${orderNoText}，总金额 ¥${Number(result.summary.total).toFixed(2)}`);
        localStorage.removeItem('cartToken');
        await ensureCartToken();
        await Promise.all([loadCart(), loadOrderHistory(), loadMenu()]);
        document.getElementById('cartPanel').classList.remove('active');
    } catch (error) {
        showNotification(error.message || '结算失败');
    }
}

async function openOrderHistoryModal() {
    document.getElementById('orderHistoryModal').classList.add('active');
    await loadOrderHistory();
}

function closeOrderHistoryModal() {
    document.getElementById('orderHistoryModal').classList.remove('active');
}

async function loadOrderHistory() {
    try {
        state.orderHistory = await api.getCheckoutHistory(20);
        renderOrderHistory();
    } catch (error) {
        showNotification(error.message || '加载订单历史失败');
    }
}

function renderOrderHistory() {
    const container = document.getElementById('orderHistoryList');
    const orders = state.orderHistory || [];

    if (!orders.length) {
        container.innerHTML = '<p class="empty-cart">暂无订单历史</p>';
        return;
    }

    container.innerHTML = orders.map(order => {
        const itemsHtml = (order.items || []).map(item => `
            <div class="history-item-row">
                <div>
                    <div class="history-item-name">${item.dishName}</div>
                    <div class="history-item-spec">${item.specName}</div>
                </div>
                <div class="history-item-meta">x${item.quantity} · ¥${Number(item.lineTotal).toFixed(2)}</div>
            </div>
        `).join('');

        return `
            <div class="history-order-card">
                <div class="history-order-top">
                    <div>
                        <div class="history-order-no">订单号：${order.orderNo}</div>
                        <div class="history-order-time">${formatDateTime(order.checkedOutAt)}</div>
                    </div>
                    <div class="history-order-total">¥${Number(order.total).toFixed(2)}</div>
                </div>
                <div class="history-order-summary">共 ${order.itemCount} 件商品，配送费 ¥${Number(order.deliveryFee).toFixed(2)}</div>
                <div class="history-order-items">${itemsHtml}</div>
            </div>
        `;
    }).join('');
}

function formatDateTime(value) {
    if (!value) return '未知时间';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
}

function showNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        background: #333;
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        z-index: 1000;
        animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 2000);
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(400px); opacity: 0; }
    }
`;
document.head.appendChild(style);
