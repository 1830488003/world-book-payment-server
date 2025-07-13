// --- 核心依赖 ---
const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const path = require('path');

// --- 初始化 Express 应用 ---
const app = express();

// --- 初始化 Upstash Redis 数据库客户端 ---
// 使用 Vercel 自动注入的环境变量进行连接
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// --- 中间件配置 ---
// 1. CORS 精确配置
const allowedOrigins = [
    'http://127.0.0.1:8000', // 本地SillyTavern开发环境
    'http://localhost:8000',  // 备用本地地址
];
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
};

app.use(cors(corsOptions));

// 2. JSON 解析
app.use(express.json());

// 3. 静态文件服务 (用于后台管理页面)
// 在单一入口架构下，此行代码至关重要，必须启用。
// 使用 path.join 和 __dirname 构建一个绝对可靠的路径，确保能找到 public 目录。
app.use(express.static(path.join(__dirname, '../public')));


// --- 安全与配置 ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qq67564534';
const tiers = {
    'tier1': { price: 10, credits: 100 },
    'tier2': { price: 20, credits: 300 },
    'tier3': { price: 30, credits: 500 },
};

// --- 辅助函数 ---
const generateOrderId = () => {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += Math.floor(Math.random() * 10);
    }
    return code;
};

// --- API 路由 ---

// 1. 创建支付订单 (给插件调用)
app.post('/api/create-order', async (req, res) => {
    try {
        const { tier } = req.body;
        if (!tier || !tiers[tier]) {
            return res.status(400).json({ error: 'Invalid tier selected' });
        }

        const selectedTier = tiers[tier];
        const orderId = generateOrderId();
        const newOrder = {
            id: orderId,
            tier,
            price: selectedTier.price,
            credits: selectedTier.credits,
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        // 将新订单对象直接存入 Redis 的 Hash 中，Vercel KV 会自动处理序列化
        await redis.hset('orders', { [orderId]: newOrder });

        res.json({
            orderId: newOrder.id,
            price: newOrder.price,
        });
    } catch (error) {
        console.error('Error in /api/create-order:', error);
        res.status(500).json({ message: '服务器在创建订单时发生内部错误。', error: error.message });
    }
});

// 2. 查询支付状态 (给插件调用)
app.get('/api/order-status', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }

        const orderData = await redis.hget('orders', orderId);

        if (!orderData) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Vercel KV 自动反序列化，orderData 已经是对象
        const order = orderData;
        res.json({ status: order.status, credits: order.credits });
    } catch (error) {
        console.error('Error in /api/order-status:', error);
        res.status(500).json({ message: '服务器在查询订单状态时发生内部错误。', error: error.message });
    }
});

// --- 后台管理 API ---

// 中间件：验证管理员密码
const checkAdminPassword = (req, res, next) => {
    const password = req.query.password || (req.body && req.body.password);
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ message: 'Unauthorized: Invalid password' });
    }
    next();
};

// 3. 获取待处理订单 (给后台管理页面调用)
app.get('/api/pending-orders', checkAdminPassword, async (req, res) => {
    try {
        const allOrders = await redis.hgetall('orders');
        if (!allOrders) {
            return res.json([]);
        }

        // Vercel KV 返回的 hgetall 的值已经是反序列化后的对象，无需手动解析
        const pendingOrders = Object.values(allOrders)
            .filter(order => order && typeof order === 'object' && order.status === 'pending') // 过滤掉所有非对象和非待处理的订单
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json(pendingOrders);
    } catch (error) {
        console.error('Error in /api/pending-orders:', error);
        res.status(500).json({ message: '服务器在获取待处理订单时发生内部错误。', error: error.message });
    }
});

// 4. 确认订单 (给后台管理页面调用)
app.post('/api/confirm-order', checkAdminPassword, async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }

        const orderData = await redis.hget('orders', orderId);

        if (!orderData) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Vercel KV 自动反序列化，orderData 已经是对象
        const order = orderData;

        if (order.status === 'completed') {
            return res.status(400).json({ message: 'Order already completed' });
        }

        order.status = 'completed';

        // 将更新后的订单对象直接写回 Redis，Vercel KV 会自动处理序列化
        await redis.hset('orders', { [orderId]: order });

        res.json({ success: true, message: `Order ${orderId} has been confirmed.` });
    } catch (error) {
        console.error('Error in /api/confirm-order:', error);
        res.status(500).json({ message: '服务器在确认订单时发生内部错误。', error: error.message });
    }
});

// 导出app，供Vercel使用
module.exports = app;
