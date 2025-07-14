// --- 核心依赖 ---
const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');
const path = require('path');
const jwt = require('jsonwebtoken'); // 引入jsonwebtoken

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
    'https://world-book-payment-server.vercel.app', // 生产环境域名 (为admin.html页面本身)
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
const JWT_SECRET = process.env.JWT_SECRET || 'a-very-strong-and-secret-key-for-jwt'; // 强烈建议在Vercel环境变量中设置一个更复杂的密钥
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

// 新增 API: 1. 生成临时的、带签名的支付口令 (JWT)
app.post('/api/generate-payment-code', (req, res) => {
    try {
        const { tier } = req.body;
        if (!tier || !tiers[tier]) {
            return res.status(400).json({ error: '无效的充值档位' });
        }

        // 使用 tier 和一个随机数创建 payload，增加唯一性
        const payload = {
            tier: tier,
            nonce: Math.random().toString(36).substring(7) 
        };

        // 生成 JWT，有效期为1小时
        const paymentCode = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
        
        res.json({
            paymentCode: paymentCode,
            price: tiers[tier].price
        });

    } catch (error) {
        console.error('Error in /api/generate-payment-code:', error);
        res.status(500).json({ message: '服务器在生成支付口令时发生内部错误。', error: error.message });
    }
});


// 修改后的 API: 2. 使用支付口令创建真实订单
app.post('/api/create-order', async (req, res) => {
    try {
        const { paymentCode } = req.body;
        if (!paymentCode) {
            return res.status(400).json({ error: '缺少支付口令 (paymentCode)' });
        }

        // 验证并解码 JWT
        const decoded = jwt.verify(paymentCode, JWT_SECRET);
        const { tier } = decoded;

        if (!tier || !tiers[tier]) {
            return res.status(400).json({ error: '支付口令无效或已过期' });
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
            paymentCode: paymentCode, // (可选) 记录用于创建订单的口令
        };

        await redis.hset('orders', { [orderId]: newOrder });

        // 返回真实的 orderId，用于前端轮询
        res.json({
            orderId: newOrder.id,
        });

    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(401).json({ message: '支付口令无效或被篡改。', error: error.message });
        }
        if (error instanceof jwt.TokenExpiredError) {
            return res.status(401).json({ message: '支付口令已过期，请重新生成。', error: error.message });
        }
        console.error('Error in /api/create-order:', error);
        res.status(500).json({ message: '服务器在创建订单时发生内部错误。', error: error.message });
    }
});


// 3. 查询支付状态 (给插件调用)
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

// 4. 获取待处理订单 (给后台管理页面调用)
app.get('/api/pending-orders', async (req, res) => {
    try {
        // 权限验证逻辑移入 try...catch 块
        const { password } = req.query;
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ message: 'Unauthorized: Invalid password' });
        }

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

// 5. 确认订单 (给后台管理页面调用)
app.post('/api/confirm-order', async (req, res) => {
    try {
        // 权限验证逻辑移入 try...catch 块
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

        // Vercel KV 自动反序列化，orderData 已经是对象
        const originalOrder = orderData;

        if (originalOrder.status === 'completed') {
            return res.status(400).json({ message: 'Order already completed' });
        }

        // 创建一个全新的订单对象副本，而不是直接修改从数据库返回的对象
        const updatedOrder = {
            ...originalOrder,
            status: 'completed',
        };

        // 将更新后的、全新的订单对象写回 Redis
        await redis.hset('orders', { [orderId]: updatedOrder });

        res.json({ success: true, message: `Order ${orderId} has been confirmed.` });
    } catch (error) {
        console.error('Error in /api/confirm-order:', error);
        res.status(500).json({ message: '服务器在确认订单时发生内部错误。', error: error.message });
    }
});

// --- 全局错误处理中间件 (最后的防线) ---
// 这个中间件必须定义在所有其他 app.use() 和路由之后
// 它可以捕获来自其他中间件（如 express.json()）的、未被处理的异常
app.use((err, req, res, next) => {
    console.error('[GLOBAL ERROR HANDLER] Uncaught Exception:', err);
    // 确保即使在最坏的情况下也返回JSON，而不是HTML
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
