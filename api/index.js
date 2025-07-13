// 引入必要的库
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// 创建 Express 应用实例
const app = express();

// 使用中间件
app.use(cors()); // 允许所有来源的跨域请求，方便插件调用
app.use(express.json()); // 解析请求体中的JSON数据

// 定义数据库文件路径
// Vercel部署时，文件系统是只读的，但/tmp/目录是可写的
// 为了本地开发和Vercel部署都能工作，我们做一个判断
const dbPath = process.env.VERCEL ? '/tmp/db.json' : path.join(__dirname, '..', 'db.json');

// 辅助函数：读取数据库
const readDB = () => {
    // 如果Vercel环境下/tmp/db.json不存在，则从项目模板复制一个空的过去
    if (process.env.VERCEL && !fs.existsSync(dbPath)) {
        fs.copyFileSync(path.join(__dirname, '..', 'db.json'), dbPath);
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

// 辅助函数：生成随机支付口令
const generatePaymentCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
};

// --- API 路由定义 ---

// 1. 创建支付请求 (给插件调用)
app.post('/api/create-payment', (req, res) => {
    const { requestId, tier } = req.body;
    if (!requestId || !tier) {
        return res.status(400).json({ error: 'requestId and tier are required' });
    }

    if (!tiers[tier]) {
        return res.status(400).json({ error: 'Invalid tier selected' });
    }

    const selectedTier = tiers[tier];
    const db = readDB();
    const paymentCode = generatePaymentCode();
    const newOrder = {
        requestId,
        paymentCode,
        tier, // tier1, tier2, tier3
        price: selectedTier.price,
        credits: selectedTier.credits,
        status: 'pending', // 状态: pending, paid
        createdAt: new Date().toISOString(),
    };

    db.push(newOrder);
    writeDB(db);

    // 返回支付口令和价格，二维码由前端处理
    res.json({
        paymentCode,
        price: selectedTier.price,
    });
});

// 2. 查询支付状态 (给插件调用)
app.get('/api/payment-status', (req, res) => {
    const { requestId } = req.query;
    if (!requestId) {
        return res.status(400).json({ error: 'requestId is required' });
    }

    const db = readDB();
    const order = db.find(o => o.requestId === requestId);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    const responsePayload = { status: order.status };
    // 如果已支付，则返回购买的次数
    if (order.status === 'paid') {
        responsePayload.credits = order.credits;
    }

    res.json(responsePayload);
});

// 3. 确认支付 (给你自己后台管理页面调用)
// 为了安全，我们加一个简单的密码验证
const ADMIN_SECRET = 'your-super-secret-password'; // 强烈建议换成一个更复杂的密码

app.post('/api/confirm-payment', (req, res) => {
    const { paymentCode, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden: Invalid secret' });
    }

    if (!paymentCode) {
        return res.status(400).json({ error: 'paymentCode is required' });
    }

    const db = readDB();
    const order = db.find(o => o.paymentCode === paymentCode);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    order.status = 'paid';
    writeDB(db);

    res.json({ success: true, message: `Order for ${paymentCode} confirmed.` });
});


// 4. 后台管理页面 (给你自己用)
app.get('/admin', (req, res) => {
    const db = readDB();
    const pendingOrders = db.filter(o => o.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    let html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>支付确认后台</title>
            <style>
                body { font-family: sans-serif; margin: 2em; background: #f4f4f4; }
                h1 { color: #333; }
                .container { background: white; padding: 2em; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .order { border: 1px solid #ddd; padding: 1em; margin-bottom: 1em; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
                .order-code { font-family: monospace; font-size: 1.5em; font-weight: bold; color: #d9534f; }
                .order-time { color: #666; font-size: 0.9em; }
                .confirm-btn { background: #5cb85c; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; }
                .confirm-btn:hover { background: #4cae4c; }
                #password-container { margin-bottom: 1em; }
                #password { padding: 8px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>待处理订单</h1>
                <div id="password-container">
                    <label for="password">后台密码: </label>
                    <input type="password" id="admin-secret" placeholder="请输入后台密码">
                </div>
                <div id="orders-list">
                    ${pendingOrders.map(order => `
                        <div class="order">
                            <div>
                                <div class="order-code">${order.paymentCode}</div>
                                <div class="order-info">
                                    <span>金额: <strong>${order.price}元</strong></span> | 
                                    <span>次数: <strong>${order.credits}次</strong></span>
                                </div>
                                <div class="order-time">创建于: ${new Date(order.createdAt).toLocaleString('zh-CN')}</div>
                            </div>
                            <button class="confirm-btn" onclick="confirmPayment('${order.paymentCode}')">确认收款</button>
                        </div>
                    `).join('')}
                </div>
            </div>
            <script>
                async function confirmPayment(paymentCode) {
                    const secret = document.getElementById('admin-secret').value;
                    if (!secret) {
                        alert('请输入后台密码!');
                        return;
                    }
                    if (!confirm(\`确定要将订单 \${paymentCode} 标记为已支付吗？\`)) {
                        return;
                    }
                    try {
                        const response = await fetch('/api/confirm-payment', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ paymentCode, secret })
                        });
                        const result = await response.json();
                        if (response.ok && result.success) {
                            alert('确认成功!');
                            location.reload();
                        } else {
                            alert('错误: ' + (result.error || '未知错误'));
                        }
                    } catch (err) {
                        alert('网络请求失败: ' + err.message);
                    }
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});


// 启动服务器
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// 导出app，供Vercel使用
module.exports = app;
