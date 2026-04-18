const API_BASE = '';

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: options.body instanceof FormData
            ? (options.headers || {})
            : {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || '请求失败');
    }
    return data;
}

const api = {
    getMenu() {
        return apiRequest('/api/menu');
    },

    getRecommendations(limit = 6) {
        return apiRequest(`/api/recommendations?limit=${encodeURIComponent(limit)}`);
    },

    getCategories() {
        return apiRequest('/api/categories');
    },

    createCategory(payload) {
        return apiRequest('/api/categories', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    deleteCategory(categoryId) {
        return apiRequest(`/api/categories/${categoryId}`, {
            method: 'DELETE'
        });
    },

    createDish(formData) {
        return apiRequest('/api/dishes', {
            method: 'POST',
            body: formData
        });
    },

    deleteDish(dishId) {
        return apiRequest(`/api/dishes/${dishId}`, {
            method: 'DELETE'
        });
    },

    createCart() {
        return apiRequest('/api/cart/create', {
            method: 'POST',
            body: JSON.stringify({})
        });
    },

    getCart(cartToken) {
        return apiRequest(`/api/cart?cartToken=${encodeURIComponent(cartToken)}`);
    },

    addCartItem(payload) {
        return apiRequest('/api/cart/items', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    updateCartItem(itemId, payload) {
        return apiRequest(`/api/cart/items/${itemId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
    },

    removeCartItem(itemId) {
        return apiRequest(`/api/cart/items/${itemId}`, {
            method: 'DELETE'
        });
    },

    checkout(payload) {
        return apiRequest('/api/cart/checkout', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    },

    getCheckoutHistory(limit = 20) {
        return apiRequest(`/api/checkout-history?limit=${encodeURIComponent(limit)}`);
    }
};
