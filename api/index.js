// --- 核心依赖 ---
const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const path = require('path');

// --- 初始化 Express 应用 ---
const app = express();

// --- 初始化 Upstash Redis 数据库客户端 ---
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// --- 中间件配置 ---
const allowedOrigins = [
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'https://world-book-payment-server.vercel.app',
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
app.use(express.json());
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

// API 1: 创建支付订单 (用户选择档位时调用)
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
            status: 'pending', // 初始状态：待用户确认付款
            createdAt: new Date().toISOString(),
        };

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

// API 2: 用户确认已付款 (用户点击“我已付款”时调用)
app.post('/api/user-confirm-payment', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }

        const orderData = await redis.hget('orders', orderId);
        if (!orderData) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // 只更新状态为 'pending' 的订单
        if (orderData.status === 'pending') {
            const updatedOrder = { ...orderData, status: 'user_confirmed' }; // 新状态：用户已确认，待管理员审核
            await redis.hset('orders', { [orderId]: updatedOrder });
        }
        
        res.json({ success: true, message: 'Payment confirmation received.' });

    } catch (error) {
        console.error('Error in /api/user-confirm-payment:', error);
        res.status(500).json({ message: '服务器在确认用户付款时发生内部错误。', error: error.message });
    }
});


// API 3: 查询支付状态 (给前端轮询调用)
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
        
        res.json({ status: orderData.status, credits: orderData.credits });
    } catch (error) {
        console.error('Error in /api/order-status:', error);
        res.status(500).json({ message: '服务器在查询订单状态时发生内部错误。', error: error.message });
    }
});

// --- 后台管理 API ---

// API 4: 获取待处理订单 (现在包含 'pending' 和 'user_confirmed')
app.get('/api/pending-orders', async (req, res) => {
    try {
        const { password } = req.query;
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ message: 'Unauthorized: Invalid password' });
        }

        const allOrders = await redis.hgetall('orders');
        if (!allOrders) {
            return res.json([]);
        }

        const pendingOrders = Object.values(allOrders)
            .filter(order => order && typeof order === 'object' && order.status === 'user_confirmed')
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json(pendingOrders);
    } catch (error) {
        console.error('Error in /api/pending-orders:', error);
        res.status(500).json({ message: '服务器在获取待处理订单时发生内部错误。', error: error.message });
    }
});

// API 5: 确认订单 (管理员操作)
app.post('/api/confirm-order', async (req, res) => {
    try {
        const { orderId, password } = req.body;
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ message: 'Unauthorized: Invalid password' });
        }
        if (!orderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }

        const orderData = await redis.hget('orders', orderId);
        if (!orderData) {
            return res.status(404).json({ message: 'Order not found' });
        }

        if (orderData.status === 'completed') {
            return res.status(400).json({ message: 'Order already completed' });
        }

        const updatedOrder = { ...orderData, status: 'completed' };
        await redis.hset('orders', { [orderId]: updatedOrder });

        res.json({ success: true, message: `Order ${orderId} has been confirmed.` });
    } catch (error) {
        console.error('Error in /api/confirm-order:', error);
        res.status(500).json({ message: '服务器在确认订单时发生内部错误。', error: error.message });
    }
});

// --- 全局错误处理中间件 ---
app.use((err, req, res, next) => {
    console.error('[GLOBAL ERROR HANDLER] Uncaught Exception:', err);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({
        message: '服务器发生了一个意外的、未被捕获的错误。',
        error: err.message,
    });
});

// 导出app，供Vercel使用
module.exports = app;
