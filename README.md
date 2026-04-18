# 点餐页面 API + MySQL + XGBoost 推荐版



- 最终推荐结果 **加权计算**
- 权重里的 `preferenceMatch`会先从 **最近 20 条订单历史** 中提取 **口味标签 + 食材标签**
- 再交给 **XGBoost** 学习偏好分数
- 最后仍然按下面这套公式做综合排序：

```text
FinalScore = 0.5 * PreferenceScore
           + 0.2 * SalesScore
           + 0.15 * ReviewScore
           + 0.15 * RatingScore
```

其中：

- `PreferenceScore`：XGBoost 输出的偏好分数（0~1）
- `SalesScore`：销量归一化分数
- `ReviewScore`：好评占比 × 评论量归一化分数
- `RatingScore`：评分归一化分数


## 环境要求

### Node.js
建议：
- Node.js 18+

### MySQL
建议：
- MySQL 8.x

### Python
建议：
- Python 3.10+

### Python 包
需要安装：

```bash
cd backend
pip install -r requirements-recommend.txt
```

如果你的电脑上 `pip` 对应的是 Python 2 或者命令不可用，可以改用：

```bash
python -m pip install -r requirements-recommend.txt
```

Windows 上如果你需要手动指定 Python，可在 `backend/.env` 里新增：

```env
PYTHON_BIN=python
```

如果你的系统默认命令不是 `python`，可以改成你本机实际可用的命令名。

---

## 启动步骤

### 1. 执行数据库脚本
执行：

```sql
source /你的路径/order_app_api_mysql/backend/schema.sql;
```

如果你已经有旧库，也可以直接重新执行当前 `schema.sql`，它会自动尝试补列。

---

### 2. 安装后端依赖
```bash
cd backend
npm install
```

---

### 3. 安装 Python 推荐依赖
```bash
cd backend
pip install -r requirements-recommend.txt
```

---

### 4. 配置 `.env`
把：

- `backend/.env.example` 复制成 `backend/.env`

并确认里面的 MySQL 连接信息正确。


---

### 5. 启动后端
```bash
cd backend
npm start
```

访问：

```text
http://localhost:3000
```

---



## 推荐算法

### 1：从历史提取偏好样本
来源：最近 20 条 `checkout_history_items`

每条历史会提取：
- 菜品对应的口味标签
- 菜品对应的食材标签
- 数量
- 订单新旧程度

其中：
- 越新的订单，权重越高
- 点得越多，权重越高

---

### 2：XGBoost 学偏好分数
`backend/recommender_xgb.py` 会：

1. 把口味 / 食材标签编码成特征向量
2. 用历史正样本 + 自动构造的负样本训练二分类模型
3. 对当前菜单里的每道菜输出一个偏好概率
4. 再把概率归一化为 `PreferenceScore`

---
