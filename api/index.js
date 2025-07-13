// 引入必要的库
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// 创建 Express 应用实例
const app = express();

// --- 静态文件服务 ---
// 让 Express 应用自己来托管 public 目录下的静态文件。
// 这样可以确保无论 Vercel 的路由配置如何，管理页面都能被正确访问。
app.use(express.static(path.join(__dirname, '..', 'public')));


// --- 安全设置 ---
// 从环境变量读取管理员密码，如果不存在，则使用您提供的默认密码
// 部署到Vercel时，强烈建议在Vercel后台设置名为ADMIN_PASSWORD的环境变量
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qq67564534';

// 使用中间件

// --- CORS 精确配置 ---
// 定义允许访问的来源白名单
const allowedOrigins = [
    'http://127.0.0.1:8000', // 本地SillyTavern开发环境
    'http://localhost:8000',  // 备用本地地址
    // 在这里添加你部署后的前端Vercel地址，例如: 'https://your-plugin-frontend.vercel.app'
];

const corsOptions = {
    origin: (origin, callback) => {
        // 如果请求来源在白名单内，或者请求没有来源（例如来自服务器自身或Postman等工具），则允许
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true, // 允许前端请求携带凭证（如cookies）
};

app.use(cors(corsOptions));
app.use(express.json()); // 解析请求体中的JSON数据


// 定义数据库文件路径
// Vercel部署时，文件系统是只读的，但/tmp/目录是可写的
const dbPath = process.env.VERCEL ? '/tmp/db.json' : path.join(__dirname, '..', 'db.json');

// 辅助函数：初始化并读取数据库
const readDB = () => {
    // 如果Vercel环境下/tmp/db.json不存在，则从项目模板复制一个空的过去
    if (process.env.VERCEL && !fs.existsSync(dbPath)) {
        const sourceDbPath = path.join(__dirname, '..', 'db.json');
        if (fs.existsSync(sourceDbPath)) {
            fs.copyFileSync(sourceDbPath, dbPath);
        } else {
            // 如果源db.json也不存在，就创建一个空的
            fs.writeFileSync(dbPath, '[]', 'utf8');
        }
    }
    const data = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(data);
};

// 辅助函数：写入数据库
const writeDB = (data) => {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 4));
};

// 定义充值档位
const tiers = {
    'tier1': { price: 10, credits: 100 },
    'tier2': { price: 20, credits: 300 },
    'tier3': { price: 30, credits: 500 },
};

// 辅助函数：生成随机支付口令 (新：6位纯数字)
const generateOrderId = () => {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += Math.floor(Math.random() * 10);
    }
    return code;
};

// --- API 路由定义 ---

// 1. 创建支付订单 (给插件调用)
app.post('/api/create-order', (req, res) => {
    try {
        const { tier } = req.body;
        if (!tier || !tiers[tier]) {
            return res.status(400).json({ error: 'Invalid tier selected' });
        }

        const selectedTier = tiers[tier];
        const db = readDB();
        const orderId = generateOrderId();
        const newOrder = {
            id: orderId,
            tier,
            price: selectedTier.price,
            credits: selectedTier.credits,
            status: 'pending', // 状态: pending, completed
            createdAt: new Date().toISOString(),
        };

        db.push(newOrder);
        writeDB(db);

        res.json({
            orderId: newOrder.id,
            price: newOrder.price,
        });
    } catch (error) {
        console.error('Error in /api/create-order:', error);
        res.status(500).json({
            message: '服务器在创建订单时发生内部错误。',
            error: error.message,
        });
    }
});

// 2. 查询支付状态 (给插件调用)
app.get('/api/order-status', (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }

        const db = readDB();
        const order = db.find(o => o.id === orderId);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ status: order.status, credits: order.credits });
    } catch (error) {
        console.error('Error in /api/order-status:', error);
        res.status(500).json({
            message: '服务器在查询订单状态时发生内部错误。',
            error: error.message,
        });
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
app.get('/api/pending-orders', checkAdminPassword, (req, res) => {
    try {
        const db = readDB();
        const pendingOrders = db.filter(o => o.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(pendingOrders);
    } catch (error) {
        console.error('Error in /api/pending-orders:', error);
        res.status(500).json({
            message: '服务器在获取待处理订单时发生内部错误。',
            error: error.message,
        });
    }
});

// 4. 确认订单 (给后台管理页面调用)
app.post('/api/confirm-order', checkAdminPassword, (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }

        const db = readDB();
        const order = db.find(o => o.id === orderId);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        if (order.status === 'completed') {
            return res.status(400).json({ message: 'Order already completed' });
        }

        order.status = 'completed';
        writeDB(db);

        res.json({ success: true, message: `Order ${orderId} has been confirmed.` });

    } catch (error) {
        // 增加全局错误捕获，防止任何意外（特别是文件写入失败）导致服务器崩溃
        console.error('Error in /api/confirm-order:', error);
        res.status(500).json({
            message: '服务器在确认订单时发生内部错误。',
            error: error.message,
        });
    }
});

// 根据Vercel的最佳实践，静态文件现在位于根目录的 /public 文件夹下，
// Vercel会自动处理它们的服务。
// Express应用现在只专注于处理 /api/ 路径下的请求。


// 启动服务器 (主要用于本地测试)
if (process.env.NODE_ENV !== 'test') {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log('Admin password is set to:', ADMIN_PASSWORD);
    });
}

// 导出app，供Vercel使用
module.exports = app;
