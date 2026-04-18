CREATE DATABASE IF NOT EXISTS order_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE order_app;

CREATE TABLE IF NOT EXISTS stores (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    rating DECIMAL(3,2) NOT NULL DEFAULT 4.80,
    review_count INT NOT NULL DEFAULT 2500,
    distance_km DECIMAL(4,1) NOT NULL DEFAULT 3.2,
    delivery_minutes INT NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL UNIQUE,
    icon VARCHAR(20) DEFAULT '🍽️',
    description VARCHAR(255) DEFAULT '',
    color VARCHAR(20) DEFAULT '#ff9800',
    display_order INT DEFAULT 999,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dishes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255) DEFAULT '',
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(255) DEFAULT 'https://via.placeholder.com/200x150?text=%E8%8F%9C%E5%93%81',
    sales INT NOT NULL DEFAULT 0,
    good_review_count INT NOT NULL DEFAULT 0,
    bad_review_count INT NOT NULL DEFAULT 0,
    rating DECIMAL(2,1) NOT NULL DEFAULT 0.0,
    specs_json JSON NULL,
    flavor_tags_json JSON NULL,
    ingredient_tags_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_dishes_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dishes' AND COLUMN_NAME = 'good_review_count'
        ),
        'SELECT 1',
        'ALTER TABLE dishes ADD COLUMN good_review_count INT NOT NULL DEFAULT 0 AFTER sales'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dishes' AND COLUMN_NAME = 'bad_review_count'
        ),
        'SELECT 1',
        'ALTER TABLE dishes ADD COLUMN bad_review_count INT NOT NULL DEFAULT 0 AFTER good_review_count'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dishes' AND COLUMN_NAME = 'rating'
        ),
        'SELECT 1',
        'ALTER TABLE dishes ADD COLUMN rating DECIMAL(2,1) NOT NULL DEFAULT 0.0 AFTER bad_review_count'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dishes' AND COLUMN_NAME = 'flavor_tags_json'
        ),
        'SELECT 1',
        'ALTER TABLE dishes ADD COLUMN flavor_tags_json JSON NULL AFTER specs_json'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dishes' AND COLUMN_NAME = 'ingredient_tags_json'
        ),
        'SELECT 1',
        'ALTER TABLE dishes ADD COLUMN ingredient_tags_json JSON NULL AFTER flavor_tags_json'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS carts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cart_token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    cart_id INT NOT NULL,
    dish_id INT NOT NULL,
    spec_name VARCHAR(50) NOT NULL DEFAULT '标准',
    quantity INT NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
    CONSTRAINT fk_cart_items_dish FOREIGN KEY (dish_id) REFERENCES dishes(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_cart_dish_spec (cart_id, dish_id, spec_name)
);

CREATE TABLE IF NOT EXISTS checkout_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_no VARCHAR(40) NOT NULL UNIQUE,
    cart_id INT NOT NULL,
    cart_token VARCHAR(64) NOT NULL,
    item_count INT NOT NULL DEFAULT 0,
    subtotal DECIMAL(10,2) NOT NULL,
    delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    checked_out_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_checkout_history_cart_id (cart_id),
    INDEX idx_checkout_history_checked_out_at (checked_out_at)
);

CREATE TABLE IF NOT EXISTS checkout_history_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    history_id INT NOT NULL,
    dish_id INT NULL,
    dish_name VARCHAR(100) NOT NULL,
    spec_name VARCHAR(50) NOT NULL DEFAULT '标准',
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(255) DEFAULT NULL,
    flavor_tags_json JSON NULL,
    ingredient_tags_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_checkout_history_items_history FOREIGN KEY (history_id) REFERENCES checkout_history(id) ON DELETE CASCADE
);

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkout_history_items' AND COLUMN_NAME = 'flavor_tags_json'
        ),
        'SELECT 1',
        'ALTER TABLE checkout_history_items ADD COLUMN flavor_tags_json JSON NULL AFTER image_url'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkout_history_items' AND COLUMN_NAME = 'ingredient_tags_json'
        ),
        'SELECT 1',
        'ALTER TABLE checkout_history_items ADD COLUMN ingredient_tags_json JSON NULL AFTER flavor_tags_json'
    )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO stores (name, rating, review_count, distance_km, delivery_minutes)
SELECT 'Online Order OvO', 4.8, 2500, 3.2, 30
WHERE NOT EXISTS (SELECT 1 FROM stores);

INSERT INTO categories (name, icon, description, color, display_order)
SELECT '虾', '🦐', '鲜虾菜品', '#ff9800', 1
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='虾');

INSERT INTO categories (name, icon, description, color, display_order)
SELECT '鱼', '🐟', '海鲜鱼类', '#03a9f4', 2
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name='鱼');

INSERT INTO dishes (
    category_id, name, description, price, image_url, sales,
    good_review_count, bad_review_count, rating, specs_json,
    flavor_tags_json, ingredient_tags_json
)
SELECT c.id, '清蒸大虾', '新鲜大虾，清蒸制作', 68.00,
       'https://via.placeholder.com/200x150?text=%E6%B8%85%E8%92%B8%E5%A4%A7%E8%99%BE',
       2100, 320, 12, 4.8,
       JSON_ARRAY('半份','一份','两份'),
       JSON_ARRAY('清淡','鲜香'),
       JSON_ARRAY('虾','海鲜')
FROM categories c
WHERE c.name = '虾' AND NOT EXISTS (SELECT 1 FROM dishes WHERE name = '清蒸大虾');

INSERT INTO dishes (
    category_id, name, description, price, image_url, sales,
    good_review_count, bad_review_count, rating, specs_json,
    flavor_tags_json, ingredient_tags_json
)
SELECT c.id, '清蒸鱼', '新鲜海鱼，清蒸保留原味', 78.00,
       'https://via.placeholder.com/200x150?text=%E6%B8%85%E8%92%B8%E9%B1%BC',
       1950, 260, 18, 4.6,
       JSON_ARRAY('半条','一条','一条半'),
       JSON_ARRAY('清淡','鲜香'),
       JSON_ARRAY('鱼','海鲜')
FROM categories c
WHERE c.name = '鱼' AND NOT EXISTS (SELECT 1 FROM dishes WHERE name = '清蒸鱼');

UPDATE dishes
SET flavor_tags_json = COALESCE(flavor_tags_json, JSON_ARRAY())
WHERE flavor_tags_json IS NULL;

UPDATE dishes
SET ingredient_tags_json = COALESCE(ingredient_tags_json, JSON_ARRAY())
WHERE ingredient_tags_json IS NULL;
