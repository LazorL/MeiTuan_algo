document.addEventListener('DOMContentLoaded', async () => {
    setupFormListeners();
    updateColorPreview();
    updateIconPreview();
    await loadExistingCategories();
});

function setupFormListeners() {
    const categoryNameInput = document.getElementById('categoryName');
    const categoryDescInput = document.getElementById('categoryDescription');
    const categoryColorInput = document.getElementById('categoryColor');
    const categoryIconInput = document.getElementById('categoryIcon');

    categoryNameInput.addEventListener('input', e => {
        document.getElementById('charCount').textContent = e.target.value.length;
    });

    categoryDescInput.addEventListener('input', e => {
        document.getElementById('descCount').textContent = e.target.value.length;
    });

    categoryColorInput.addEventListener('input', updateColorPreview);
    categoryIconInput.addEventListener('input', updateIconPreview);
}

function updateIconPreview() {
    const icon = document.getElementById('categoryIcon').value.trim() || '🍽️';
    document.getElementById('iconPreview').textContent = icon;
}

function selectIcon(icon) {
    document.getElementById('categoryIcon').value = icon;
    updateIconPreview();
}

function updateColorPreview() {
    const color = document.getElementById('categoryColor').value;
    document.getElementById('colorPreview').style.background = color;
}

async function loadExistingCategories() {
    const list = document.getElementById('categoriesList');
    try {
        const categories = await api.getCategories();
        if (!categories.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📭</div>
                    <p>还没有添加任何品类</p>
                </div>
            `;
            return;
        }

        list.innerHTML = '';
        categories.forEach(category => {
            const item = document.createElement('div');
            item.className = 'category-item';
            item.innerHTML = `
                <div class="category-icon">${category.icon || '🍽️'}</div>
                <div class="category-info">
                    <h3>${category.name}</h3>
                    <p>${category.description || '暂无描述'}</p>
                </div>
                <div class="category-actions">
                    <button type="button" class="btn-delete" onclick="deleteCategory(${category.id})">删除</button>
                </div>
            `;
            list.appendChild(item);
        });
    } catch (error) {
        showNotification(error.message || '加载分类失败', 'error');
    }
}

async function deleteCategory(categoryId) {
    if (!confirm('确定要删除这个品类吗？删除后该分类下的菜品也会被删除。')) return;
    try {
        await api.deleteCategory(categoryId);
        await loadExistingCategories();
        showNotification('品类已删除');
    } catch (error) {
        showNotification(error.message || '删除失败', 'error');
    }
}

async function handleAddCategory(event) {
    event.preventDefault();
    const icon = document.getElementById('categoryIcon').value.trim();
    const name = document.getElementById('categoryName').value.trim();
    const description = document.getElementById('categoryDescription').value.trim();
    const color = document.getElementById('categoryColor').value;
    const displayOrder = document.getElementById('categoryOrder').value;

    if (!icon || !name) {
        showNotification('请填写品类图标和名称', 'error');
        return;
    }

    try {
        await api.createCategory({
            icon,
            name,
            description,
            color,
            displayOrder: displayOrder === '' ? null : Number(displayOrder)
        });

        document.getElementById('addCategoryForm').reset();
        document.getElementById('charCount').textContent = '0';
        document.getElementById('descCount').textContent = '0';
        document.getElementById('categoryColor').value = '#ff9800';
        updateColorPreview();
        updateIconPreview();
        await loadExistingCategories();
        showNotification('品类添加成功');
    } catch (error) {
        showNotification(error.message || '添加品类失败', 'error');
    }
}

function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 2500);
}

function goBack() {
    window.location.href = 'index.html';
}
