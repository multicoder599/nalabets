// server.js — Nalabets Backend

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());

app.use((req, res, next) => {
    Object.defineProperty(req, 'query', {
        value: { ...req.query },
        writable: true, configurable: true, enumerable: true
    });
    next();
});

app.use(mongoSanitize());

// CORS Configuration
app.use(cors({
    origin: ['https://nalabets.com', 'https://www.nalabets.com'],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
}));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: "Too many requests from this IP, please try again later." }
});
app.use('/api/', apiLimiter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nalabets';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_insecure_secret';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '581547add320d504f22fd7454a1140df';

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ MongoDB Connected');
        try {
            await mongoose.connection.collection('bets').dropIndex('bookingCode_1');
            console.log('✅ Cleared legacy booking code index');
        } catch (e) {
            // Index may not exist
        }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// Telegram Notifications
const sendTelegramMessage = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error("Telegram failed:", err.message);
    }
};

const getCryptoAddresses = () => ({
    Bitcoin: process.env.BTC_ADDRESS || 'bc1q_configure_in_env',
    USDT: process.env.USDT_ADDRESS || '0x_configure_in_env',
    USDC: process.env.USDC_ADDRESS || '0x_configure_in_env',
    Solana: process.env.SOLANA_ADDRESS || 'sol_configure_in_env',
    Litecoin: process.env.LTC_ADDRESS || 'ltc_configure_in_env'
});

// Timezone Helpers
const getTimezoneFromCountry = (countryCode, phone = '') => {
    const map = {
        KE: 'Africa/Nairobi', UG: 'Africa/Kampala', TZ: 'Africa/Dar_es_Salaam',
        NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', GH: 'Africa/Accra',
        GB: 'Europe/London', US: 'America/New_York', CA: 'America/Toronto',
        AU: 'Australia/Sydney', IN: 'Asia/Kolkata', DE: 'Europe/Berlin',
        FR: 'Europe/Paris', ES: 'Europe/Madrid', IT: 'Europe/Rome',
        BR: 'America/Sao_Paulo', MX: 'America/Mexico_City', AE: 'Asia/Dubai'
    };
    const p = String(phone).replace(/\D/g, '');
    if (p.startsWith('254')) return 'Africa/Nairobi';
    if (p.startsWith('255')) return 'Africa/Dar_es_Salaam';
    if (p.startsWith('256')) return 'Africa/Kampala';
    if (p.startsWith('234')) return 'Africa/Lagos';
    if (p.startsWith('27'))  return 'Africa/Johannesburg';
    if (p.startsWith('233')) return 'Africa/Accra';
    if (p.startsWith('44'))  return 'Europe/London';
    if (p.startsWith('1'))   return 'America/New_York';
    return map[countryCode] || 'UTC';
};

// ==========================================
// SCHEMAS
// ==========================================

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Player' },
    balance: { type: Number, default: 0.00 },
    currency: { type: String, default: 'KES' },
    oddsFormat: { type: String, default: 'decimal' },
    countryCode: { type: String, default: 'KE' },
    timezone: { type: String, default: 'Africa/Nairobi' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const MatchSchema = new mongoose.Schema({
    sport: String,
    league: String,
    country: String,
    home: String,
    away: String,
    isLive: { type: Boolean, default: false },
    status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
    startTime: { type: Date },
    timezone: { type: String, default: 'UTC' },
    time: String,
    date: String,
    score: String,
    finalScore: String,
    odds: [Number],
    markets: { type: Object, default: {} },
    result: {
        homeGoals: Number,
        awayGoals: Number,
        correctScore: String,
        btts: String,
        winner: String
    }
});
const Match = mongoose.model('Match', MatchSchema);

const BetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticketId: { type: String, required: true },
    date: { type: Date, default: Date.now },
    stake: { type: Number, required: true },
    totalOdds: { type: Number, required: true },
    potentialReturn: { type: Number, required: true },
    status: { type: String, default: 'Open', enum: ['Open', 'In Play', 'Partial', 'Won', 'Lost', 'Cancelled'] },
    currency: String,
    userTimezone: { type: String, default: 'Africa/Nairobi' },
    bookingCode: { type: String, sparse: true },
    legs: [{
        matchId: String,
        match: String,
        pick: String,
        selection: String,
        marketType: { type: String, default: '1x2' },
        odds: Number,
        startTime: Date,
        status: { type: String, default: 'Open' },
        score: String,
        finalScore: String
    }]
});
const Bet = mongoose.model('Bet', BetSchema);

const BookingSlipSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    legs: [{
        matchId: String,
        match: String,
        pick: String,
        selection: String,
        marketType: { type: String, default: '1x2' },
        odds: Number,
        startTime: Date
    }],
    stake: Number,
    totalOdds: Number,
    potentialReturn: Number,
    currency: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 } // Auto-delete after 24h
});
const BookingSlip = mongoose.model('BookingSlip', BookingSlipSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userPhone: String,
    refId: String,
    type: { type: String, required: true },
    method: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    status: { type: String, default: 'Pending' },
    proofUrl: String,
    date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

const NotificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String,
    message: String,
    isRead: { type: Boolean, default: false },
    date: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema);

// ==========================================
// JWT AUTH MIDDLEWARE
// ==========================================

const verifyUserToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access Denied. No token provided." });
    try {
        const parts = token.split(" ");
        const actualToken = parts.length === 2 ? parts[1] : parts[0];
        const verified = jwt.verify(actualToken, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
};

const verifyAdminToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access Denied" });
    try {
        const parts = token.split(" ");
        const actualToken = parts.length === 2 ? parts[1] : parts[0];
        const verified = jwt.verify(actualToken, JWT_SECRET);
        if (verified.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
        req.admin = verified;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
};

// ==========================================
// AUTH & USERS
// ==========================================

app.post('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 15 }), async (req, res) => {
    try {
        const { username, email, phone, password } = req.body;

        if (await User.findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } }))
            return res.status(400).json({ error: "Username taken" });
        if (await User.findOne({ email: { $regex: new RegExp('^' + email + '$', 'i') } }))
            return res.status(400).json({ error: "Email registered" });
        if (await User.findOne({ phone }))
            return res.status(400).json({ error: "Phone registered" });

        const cleanPhone = phone.replace(/\D/g, '');
        const isKenyan = phone.startsWith('+254') || cleanPhone.startsWith('254') ||
            (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));
        const currency = isKenyan ? 'KES' : 'USD';
        const countryCode = isKenyan ? 'KE' : 'US';
        const timezone = getTimezoneFromCountry(countryCode, phone);

        const newUser = new User({
            username, email, phone,
            password: await bcrypt.hash(password, 10),
            name: username, currency, countryCode, timezone
        });
        await newUser.save();

        await new Notification({
            userId: newUser._id,
            title: "Welcome to Nalabets!",
            message: "Your account is ready. Deposit to start playing."
        }).save();
        
        sendTelegramMessage(`🎉 <b>NEW USER</b>\n👤 ${username}\n📞 ${phone}`);

        const token = jwt.sign({ id: newUser._id, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            message: "User created",
            token,
            user: {
                _id: newUser._id, username: newUser.username, name: newUser.name,
                email: newUser.email, phone: newUser.phone, balance: newUser.balance,
                currency: newUser.currency, countryCode: newUser.countryCode,
                timezone: newUser.timezone, oddsFormat: newUser.oddsFormat,
                cryptoAddresses: getCryptoAddresses()
            }
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const digitsOnly = identifier.replace(/\D/g, '');
        const phoneQuery = digitsOnly.length >= 9
            ? { $regex: new RegExp(digitsOnly.slice(-9) + '$') }
            : identifier;

        const user = await User.findOne({
            $or: [
                { email: { $regex: new RegExp('^' + identifier + '$', 'i') } },
                { username: { $regex: new RegExp('^' + identifier + '$', 'i') } },
                { phone: phoneQuery },
                { phone: identifier }
            ]
        });

        if (!user || !(await bcrypt.compare(password, user.password)))
            return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign({ id: user._id, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });

        res.status(200).json({
            message: "Login successful",
            token,
            user: {
                _id: user._id, username: user.username, name: user.name,
                email: user.email, phone: user.phone, balance: user.balance,
                currency: user.currency, countryCode: user.countryCode,
                timezone: user.timezone, oddsFormat: user.oddsFormat,
                cryptoAddresses: getCryptoAddresses()
            }
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/user/:id/profile', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized access to profile" });
        }
        const user = await User.findById(req.params.id).select('-password');
        if (!user) return res.status(404).send();
        const payload = user.toObject();
        payload.cryptoAddresses = getCryptoAddresses();
        res.status(200).json(payload);
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/user/:id/notifications', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: "Unauthorized" });
        }
        const notifs = await Notification.find({
            $or: [{ userId: req.params.id }, { userId: null }]
        }).sort({ date: -1 }).limit(30);
        res.status(200).json(notifs);
    } catch (err) {
        res.status(500).send();
    }
});

// Admin Login
app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
    const { password } = req.body;
    if (password === (process.env.ADMIN_PASS || 'nalabets@2026')) {
        res.status(200).json({
            message: "Auth successful",
            token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' })
        });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

// ==========================================
// DEPOSIT & M-PESA
// ==========================================

app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, method } = req.body;
        const amount = parseFloat(req.body.amount);

        if (!userPhone) return res.status(400).json({ success: false, message: 'Phone required' });
        if (isNaN(amount) || amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is KES 10' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

        let formattedPhone = userPhone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
        else if (/^[71]/.test(formattedPhone)) formattedPhone = '254' + formattedPhone;
        else if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

        if (formattedPhone.length !== 12) {
            return res.status(400).json({ success: false, message: 'Invalid phone format' });
        }

        const reference = 'DEP' + Date.now();

        const payload = {
            api_key: process.env.MEGAPAY_API_KEY || 'MGPYgGQ0Lpl4',
            email: process.env.MEGAPAY_EMAIL || 'gleah6423@gmail.com',
            amount: amount,
            msisdn: formattedPhone,
            callback_url: `${process.env.APP_URL || 'https://api.nalabets.com/api'}/api/megapay/webhook`,
            description: 'Nalabets Deposit',
            reference: reference
        };

        try {
            const mpRes = await axios.post(
                'https://megapay.co.ke/backend/v1/initiatestk',
                payload,
                { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );

            const mpData = mpRes.data;
            if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
                return res.status(400).json({
                    success: false,
                    message: mpData.errorMessage || mpData.message || 'Gateway rejected request'
                });
            }
        } catch (mpErr) {
            console.error('MegaPay error:', mpErr.response?.data || mpErr.message);
            return res.status(502).json({
                success: false,
                message: 'Payment gateway failed to send STK push'
            });
        }

        await Transaction.create({
            refId: reference,
            userId: user._id,
            userPhone: user.phone,
            type: 'Deposit',
            method: method || 'M-Pesa',
            amount: amount,
            currency: user.currency || 'KES',
            status: 'Pending'
        });

        res.status(200).json({
            success: true,
            message: 'STK Push sent! Check your phone and enter M-Pesa PIN.',
            newBalance: user.balance,
            refId: reference
        });

    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return;
        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        const last9 = (data.Msisdn || data.phone || data.PhoneNumber || "").toString().replace(/\D/g, '').slice(-9);
        if (last9.length < 9) return;

        const user = await User.findOne({ phone: { $regex: new RegExp(last9 + '$') } });
        if (!user || await Transaction.findOne({ refId: receipt })) return;

        user.balance += amount;
        await user.save();
        await Transaction.create({
            refId: receipt,
            userId: user._id,
            userPhone: user.phone,
            type: "Deposit",
            method: "M-Pesa",
            amount: amount,
            status: "Success"
        });
        await new Notification({
            userId: user._id,
            title: "Deposit Successful",
            message: `Your deposit of ${user.currency || 'KES'} ${amount} has been credited. Receipt: ${receipt}`
        }).save();
        sendTelegramMessage(`💵 <b>DEPOSIT</b>\n📱 ${user.phone}\n💰 KES ${amount}\n🧾 ${receipt}`);
    } catch (err) {
        console.error('Webhook error:', err);
    }
});

// ==========================================
// WALLET (MANUAL)
// ==========================================

app.post('/api/wallet/deposit/manual', verifyUserToken, async (req, res) => {
    try {
        const { userId, amount, currency, method, proofSubmitted } = req.body;
        if (req.user.id !== userId) return res.status(403).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user) return res.status(404).send();

        await Transaction.create({
            userId, type: 'Deposit', method, amount, currency,
            status: 'Pending', proofUrl: proofSubmitted ? 'Proof Submitted' : 'Pending'
        });
        
        await new Notification({
            userId: user._id,
            title: "Deposit Processing",
            message: `Your manual deposit of ${currency} ${amount} via ${method} is being reviewed.`
        }).save();

        sendTelegramMessage(`⏳ <b>MANUAL DEPOSIT</b>\n👤 ${user.username}\n💳 ${method}\n💰 ${amount} ${currency}`);
        res.status(200).json({ message: "Deposit requested", balance: user.balance });
    } catch (err) { res.status(500).send(); }
});

app.post('/api/wallet/withdraw', verifyUserToken, async (req, res) => {
    try {
        const { userId, amount, currency, accountDetails } = req.body;
        if (req.user.id !== userId) return res.status(403).json({ error: "Unauthorized" });

        const user = await User.findById(userId);
        if (!user || user.balance < amount) return res.status(400).send();

        user.balance -= parseFloat(amount);
        await user.save();
        
        await Transaction.create({
            userId, type: 'Withdrawal', amount, currency, status: 'Pending'
        });

        await new Notification({
            userId: user._id,
            title: "Withdrawal Requested",
            message: `Your request to withdraw ${currency} ${amount} has been received.`
        }).save();

        sendTelegramMessage(`💸 <b>WITHDRAWAL</b>\n👤 ${user.username}\n💳 ${accountDetails}\n💰 ${amount} ${currency}`);
        res.status(200).json({ message: "Withdrawal requested", balance: user.balance });
    } catch (err) { res.status(500).send(); }
});

app.get('/api/wallet/transactions/:userId', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.userId && req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
        const txns = await Transaction.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).send(); }
});


// ==========================================
// MATCHES & ODDS BACKGROUND ENGINE
// ==========================================

let cachedApiGames = [];
let lastApiFetchTime = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; 

function getMatchTimeStr(startTimeStr) {
    if (!startTimeStr) return "";
    const elapsedMs = new Date().getTime() - new Date(startTimeStr).getTime();
    const elapsedMins = Math.floor(elapsedMs / 60000);
    
    if (elapsedMins < 0) return "Upcoming";
    if (elapsedMins <= 45) return `${elapsedMins}'`;
    if (elapsedMins > 45 && elapsedMins <= 60) return "HT"; 
    if (elapsedMins > 60 && elapsedMins <= 105) return `${45 + (elapsedMins - 60)}'`;
    if (elapsedMins > 105 && elapsedMins <= 110) return `90+${elapsedMins - 105}'`;
    if (elapsedMins > 110 && elapsedMins <= 115) return "Settling...";
    return "FT";
}

// Deterministic evenly distributed score generator over 90 mins
function getCurrentScore(matchId, startTimeStr, adminResultObj) {
    const start = new Date(startTimeStr).getTime();
    const now = new Date().getTime();
    const elapsed = now - start;
    if (elapsed < 0) return null;

    const elapsedMins = Math.floor(elapsed / 60000);
    
    // Map elapsed real time to game time (0-90)
    let gameMinute = 0;
    if (elapsedMins < 45) {
        gameMinute = elapsedMins;
    } else if (elapsedMins >= 45 && elapsedMins < 60) {
        gameMinute = 45; 
    } else if (elapsedMins >= 60 && elapsedMins < 105) {
        gameMinute = 45 + (elapsedMins - 60);
    } else {
        gameMinute = 90; 
    }

    let finalHome = 0;
    let finalAway = 0;
    
    if (adminResultObj && adminResultObj.homeGoals !== undefined) {
        finalHome = adminResultObj.homeGoals;
        finalAway = adminResultObj.awayGoals;
    } else {
        let seed = 0;
        for (let i = 0; i < matchId.length; i++) seed += matchId.charCodeAt(i);
        finalHome = seed % 4; 
        finalAway = (seed * 3) % 4; 
    }

    let currentHome = 0;
    let currentAway = 0;

    for (let i = 1; i <= finalHome; i++) {
        const goalMinute = Math.floor(90 / (finalHome + 1) * i);
        if (gameMinute >= goalMinute) currentHome++;
    }

    for (let i = 1; i <= finalAway; i++) {
        const goalMinute = Math.floor(90 / (finalAway + 1) * i);
        let offsetGoalMinute = goalMinute + (matchId.length % 3); 
        if (offsetGoalMinute > 90) offsetGoalMinute = 90;
        if (gameMinute >= offsetGoalMinute) currentAway++;
    }

    return `${currentHome}-${currentAway}`;
}

// Generate mathematically sound markets based on Moneyline (H2H) base odds
function calculateDetailedMarkets(matchId, homeOdds, drawOdds, awayOdds, sport) {
    let seed = 0;
    for(let i=0; i<matchId.length; i++) seed += matchId.charCodeAt(i);
    
    const home = parseFloat(homeOdds) || 1.1;
    const away = parseFloat(awayOdds) || 1.1;
    const draw = parseFloat(drawOdds) || 0;

    let markets = {};

    if (sport === 'football' && draw > 0) {
        // Double Chance
        markets.doubleChance = {
            '1x': parseFloat((1 / (1/home + 1/draw) + 0.04).toFixed(2)),
            '12': parseFloat((1 / (1/home + 1/away) + 0.04).toFixed(2)),
            x2: parseFloat((1 / (1/away + 1/draw) + 0.04).toFixed(2))
        };

        // BTTS
        const bttsYesBase = 1.65 + (seed % 15) / 20; 
        const bttsNoBase = 3.5 - bttsYesBase; 
        markets.btts = { yes: parseFloat(bttsYesBase.toFixed(2)), no: parseFloat(bttsNoBase.toFixed(2)) };

        // Over/Under
        const ouBase = 1.45 + (seed % 10) / 20;
        markets.overUnder = [
            { line: 1.5, over: parseFloat((ouBase - 0.25).toFixed(2)), under: parseFloat((ouBase + 1.1).toFixed(2)) },
            { line: 2.5, over: parseFloat(ouBase.toFixed(2)), under: parseFloat((3.6 - ouBase).toFixed(2)) },
            { line: 3.5, over: parseFloat((ouBase + 1.4).toFixed(2)), under: parseFloat((ouBase - 0.2).toFixed(2)) }
        ];

        // Correct Score
        markets.correctScore = [
            { score: '1-0', odds: parseFloat((home * 2.2 + (seed%3)).toFixed(2)) },
            { score: '2-0', odds: parseFloat((home * 3.2 + (seed%4)).toFixed(2)) },
            { score: '2-1', odds: parseFloat((home * 3.8 + (seed%5)).toFixed(2)) },
            { score: '0-1', odds: parseFloat((away * 2.2 + (seed%3)).toFixed(2)) },
            { score: '0-2', odds: parseFloat((away * 3.2 + (seed%4)).toFixed(2)) },
            { score: '1-2', odds: parseFloat((away * 3.8 + (seed%5)).toFixed(2)) },
            { score: '1-1', odds: parseFloat((draw * 1.8 + (seed%2)).toFixed(2)) },
            { score: '0-0', odds: parseFloat((draw * 2.3 + (seed%3)).toFixed(2)) },
            { score: '2-2', odds: parseFloat((draw * 4.2 + (seed%5)).toFixed(2)) }
        ];
        markets.h2h = { home, draw, away };
    } else {
        // Basketball/Tennis
        markets.h2h = { home, away };
        const spreadBase = sport === 'basketball' ? 215.5 : 22.5;
        markets.overUnder = [
            { line: spreadBase, over: 1.90, under: 1.90 }
        ];
    }
    return markets;
}

async function fetchAndCacheLiveOdds() {
    try {
        console.log("🔄 Fetching live odds from parlay-api.com...");
        const sportsToFetch = [
            'soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
            'basketball_nba', 'tennis_atp', 'baseball_mlb', 'mma_mixed_martial_arts', 'americanfootball_nfl'
        ];
        
        let allApiMatches = [];
        
        for (const sport of sportsToFetch) {
            try {
                const response = await axios.get(
                    `https://parlay-api.com/v1/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us,uk,eu&markets=h2h,spreads`
                );
                if (response.data && Array.isArray(response.data)) {
                    allApiMatches = allApiMatches.concat(response.data);
                }
            } catch (e) {
                console.error(`Failed to fetch sport ${sport}:`, e.message);
            }
        }
        
        const now = new Date();

        cachedApiGames = allApiMatches.map((match) => {
            const matchDate = new Date(match.commence_time);
            if (now.getTime() - matchDate.getTime() >= 0) return null;

            const market = match.bookmakers[0]?.markets[0];
            let homeOdds = 1.90, drawOdds = null, awayOdds = 1.90;

            if (market && market.outcomes) {
                const homeOutcome = market.outcomes.find(o => o.name === match.home_team);
                const awayOutcome = market.outcomes.find(o => o.name === match.away_team);
                const drawOutcome = market.outcomes.find(o => o.name === 'Draw' || (o.name !== match.home_team && o.name !== match.away_team));

                if (homeOutcome) homeOdds = homeOutcome.price;
                if (awayOutcome) awayOdds = awayOutcome.price;
                if (drawOutcome) drawOdds = drawOutcome.price;
            }

            let mappedSport = 'football';
            if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if (match.sport_key.includes('mma') || match.sport_key.includes('ufc')) mappedSport = 'mma';
            if (match.sport_key.includes('icehockey')) mappedSport = 'icehockey';
            if (match.sport_key.includes('americanfootball')) mappedSport = 'rugby';
            if (match.sport_key.includes('baseball')) mappedSport = 'baseball';

            if (mappedSport === 'football' && !drawOdds) {
                drawOdds = parseFloat(((homeOdds + awayOdds) / 1.6).toFixed(2));
                if (drawOdds < 2.5) drawOdds = 3.10;
            }

            let leagueName = match.sport_title || 'League';
            let gradeScore = mappedSport === 'football' ? 50 : 0;
            if (match.sport_key.includes('champs_league') || match.sport_key.includes('epl')) gradeScore += 75;

            const detailedMarkets = calculateDetailedMarkets(match.id, homeOdds, drawOdds, awayOdds, mappedSport);

            return {
                id: 'api_' + match.id,
                sport: mappedSport,
                region: 'Global',
                league: leagueName,
                home: match.home_team,
                away: match.away_team,
                isLive: false,
                isFeatured: gradeScore > 50,
                startTime: matchDate.toISOString(),
                date: matchDate.toISOString().split('T')[0], 
                score: null,
                odds: drawOdds ? [homeOdds, drawOdds, awayOdds] : [homeOdds, null, awayOdds],
                marketCount: mappedSport === 'football' ? 74 : 12,
                detailedMarkets: detailedMarkets,
                gradeScore: gradeScore,
                status: 'upcoming',
                result: null,
                finalScore: null
            };
        }).filter(m => m !== null);

        lastApiFetchTime = Date.now();
        console.log(`✅ Cached ${cachedApiGames.length} live matches from Parlay API`);
    } catch (e) {
        console.error("Master Odds Fetch Error:", e.message);
    }
}

// Start polling API on server boot
fetchAndCacheLiveOdds();
setInterval(fetchAndCacheLiveOdds, CACHE_DURATION_MS);


// ==========================================
// MATCH ENDPOINTS
// ==========================================

app.get('/api/matches', async (req, res) => {
    try {
        const dbMatches = await Match.find({
            status: { $in: ['upcoming', 'live'] }
        }).sort({ startTime: 1 });

        const formatted = dbMatches.map(m => {
            const obj = m.toObject();
            obj.startTime = m.startTime ? m.startTime.toISOString() : null;
            obj.date = obj.date || (obj.startTime ? new Date(obj.startTime).toISOString().split('T')[0] : null);
            obj.detailedMarkets = (obj.markets && Object.keys(obj.markets).length > 0) ? obj.markets : calculateDetailedMarkets(obj._id.toString(), obj.odds[0] || 2.1, obj.odds[1] || 3.1, obj.odds[2] || 2.8, obj.sport || 'football');
            
            if (obj.status === 'live' && obj.startTime) {
                obj.score = getCurrentScore(obj._id.toString(), obj.startTime, obj.result);
                obj.time = getMatchTimeStr(obj.startTime);
            }
            return obj;
        });

        res.status(200).json(formatted);
    } catch (err) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

app.get('/api/live-matches', async (req, res) => {
    try {
        const dbMatches = (await Match.find({ status: { $in: ['upcoming', 'live'] } })).map(m => {
            const obj = m.toObject();
            return {
                id: obj._id.toString(), 
                sport: obj.sport || 'football', 
                league: obj.league || 'League',
                country: obj.country || 'gb-eng', 
                home: obj.home, 
                away: obj.away, 
                isLive: obj.status === 'live',
                isFeatured: true, 
                startTime: obj.startTime ? obj.startTime.toISOString() : null,
                date: obj.date || (obj.startTime ? new Date(obj.startTime).toISOString().split('T')[0] : null),
                time: obj.status === 'live' ? getMatchTimeStr(obj.startTime) : null,
                score: obj.status === 'live' ? getCurrentScore(obj._id.toString(), obj.startTime, obj.result) : null,
                finalScore: obj.finalScore || null,
                odds: obj.odds || [2.1, 3.1, 2.8],
                marketCount: obj.markets && Object.keys(obj.markets).length > 0 ? (Object.keys(obj.markets).length * 5 + 20) : 74,
                detailedMarkets: (obj.markets && Object.keys(obj.markets).length > 0) ? obj.markets : calculateDetailedMarkets(obj._id.toString(), obj.odds[0] || 2.1, obj.odds[1] || 3.1, obj.odds[2] || 2.8, obj.sport || 'football'),
                gradeScore: 1000, 
                status: obj.status, 
                result: obj.result || null
            };
        });

        const now = Date.now();
        // Safe check in case cachedApiGames is undefined
        const validCached = typeof cachedApiGames !== 'undefined' ? cachedApiGames.filter(match => (now - new Date(match.startTime).getTime()) < 0) : [];

        let combined = [...dbMatches, ...validCached].sort((a, b) => b.gradeScore - a.gradeScore);

        res.status(200).json(combined.slice(0, 500));
    } catch (err) {
        console.error("Live matches error:", err);
        res.status(500).json({ error: "Could not fetch matches" });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(200).json([]);
        const dbResults = await Match.find({
            status: { $in: ['upcoming', 'live'] },
            $or: [
                { home: { $regex: query, $options: 'i' } },
                { away: { $regex: query, $options: 'i' } },
                { league: { $regex: query, $options: 'i' } }
            ]
        });
        res.status(200).json(dbResults);
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

// ==========================================
// BETTING
// ==========================================

app.post('/api/bets/place', verifyUserToken, async (req, res) => {
    try {
        let { userId, stake, totalOdds, potentialReturn, currency, legs, bookingCode } = req.body;

        if (req.user.id !== userId) return res.status(403).json({ error: "Unauthorized action." });

        stake = parseFloat(stake);
        totalOdds = parseFloat(totalOdds);

        if (isNaN(stake) || stake <= 0) return res.status(400).json({ error: "Invalid stake" });
        if (isNaN(totalOdds) || totalOdds < 1) return res.status(400).json({ error: "Invalid odds" });

        potentialReturn = parseFloat((stake * totalOdds).toFixed(2));
        if (!Array.isArray(legs) || legs.length === 0) return res.status(400).json({ error: "No legs provided" });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        if (user.balance < stake) return res.status(400).json({ error: "Insufficient balance" });

        const trackedLegs = await Promise.all(legs.map(async leg => {
            let legStartTime = leg.startTime ? new Date(leg.startTime) : null;
            if (leg.matchId && mongoose.Types.ObjectId.isValid(leg.matchId)) {
                const dbMatch = await Match.findById(leg.matchId).select('startTime');
                if (dbMatch && dbMatch.startTime) legStartTime = dbMatch.startTime;
            }
            if (!legStartTime && leg.time && leg.time.includes('•')) {
                const [dPart, tPart] = leg.time.split(' • ');
                const parsed = new Date(`${dPart} ${tPart}`);
                if (!isNaN(parsed)) legStartTime = parsed;
            }
            if (!legStartTime) legStartTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

            return {
                matchId: leg.matchId, match: leg.match, pick: leg.pick, selection: leg.selection,
                marketType: leg.marketType || '1x2', odds: parseFloat(leg.odds) || 0,
                startTime: legStartTime, status: 'Open', score: null, finalScore: null
            };
        }));

        const newBet = new Bet({
            userId: user._id,
            ticketId: "NB-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            bookingCode: bookingCode || undefined, stake, totalOdds, potentialReturn,
            currency: currency || user.currency, userTimezone: user.timezone || 'Africa/Nairobi',
            legs: trackedLegs
        });
        await newBet.save();

        user.balance -= stake;
        await user.save();

        await Transaction.create({
            userId: user._id, type: 'Bet Placed', amount: -stake,
            currency: newBet.currency, status: 'Completed'
        });
        
        await new Notification({
            userId: user._id,
            title: "Bet Placed Successfully",
            message: `Your bet ${newBet.ticketId} of ${newBet.currency} ${stake} has been placed.`
        }).save();

        sendTelegramMessage(`🎲 <b>NEW BET</b>\n👤 ${user.username}\n💰 Stake: ${stake} ${newBet.currency}\n🎯 Win: ${potentialReturn} ${newBet.currency}`);

        res.status(201).json({ message: "Bet placed", ticketId: newBet.ticketId, newBalance: user.balance, bet: newBet });
    } catch (err) {
        console.error("Bet placement error:", err);
        res.status(500).json({ error: "Failed to place bet" });
    }
});

app.get('/api/bets/user/:userId', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.userId && req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized access." });
        const bets = await Bet.find({ userId: req.params.userId }).sort({ date: -1 });
        
        const now = new Date();
        const mappedBets = bets.map(b => {
            const betObj = b.toObject();
            let hasInPlay = false;
            betObj.legs.forEach(leg => {
                if (leg.status === 'Open' && leg.startTime && new Date(leg.startTime) <= now) {
                    leg.status = 'In Play';
                    hasInPlay = true;
                }
            });
            if (betObj.status === 'Open' && hasInPlay) betObj.status = 'In Play';
            return betObj;
        });

        res.status(200).json(mappedBets);
    } catch (err) {
        res.status(500).send();
    }
});

app.post('/api/bets/save-code', async (req, res) => {
    try {
        const { code, legs, stake, totalOdds, potentialReturn, currency } = req.body;
        await BookingSlip.findOneAndUpdate(
            { code: code.toUpperCase() },
            { code: code.toUpperCase(), legs, stake, totalOdds, potentialReturn, currency },
            { upsert: true, new: true }
        );
        res.status(200).json({ success: true, message: "Code saved" });
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/bets/code/:code', async (req, res) => {
    try {
        const slip = await BookingSlip.findOne({ code: req.params.code.toUpperCase() });
        if (!slip) return res.status(404).send();
        res.status(200).json(slip);
    } catch (err) {
        res.status(500).send();
    }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.status(200).json(users);
    } catch (err) { res.status(500).send(); }
});

app.put('/api/admin/users/:id/balance/set', verifyAdminToken, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        user.balance = parseFloat(req.body.amount);
        await user.save();
        res.status(200).json({ balance: user.balance });
    } catch (err) { res.status(500).send(); }
});

app.delete('/api/admin/users/:id', verifyAdminToken, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.status(200).send();
    } catch (err) { res.status(500).send(); }
});

app.get('/api/admin/transactions', verifyAdminToken, async (req, res) => {
    try {
        const txns = await Transaction.find({ status: req.query.status || 'Pending' }).populate('userId', 'username').sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) { res.status(500).send(); }
});

app.put('/api/admin/transactions/:id/:action', verifyAdminToken, async (req, res) => {
    try {
        const action = req.params.action.toLowerCase();
        const txn = await Transaction.findById(req.params.id);
        if (!txn || txn.status !== 'Pending') return res.status(400).send();

        if (action === 'approve') {
            txn.status = 'Completed';
            if (txn.type === 'Deposit') {
                const user = await User.findById(txn.userId);
                user.balance += txn.amount;
                await user.save();
                await new Notification({ userId: user._id, title: "Deposit Approved", message: `Your deposit of ${txn.amount} ${txn.currency} was approved.` }).save();
            }
        } else if (action === 'reject') {
            txn.status = 'Failed';
            if (txn.type === 'Withdrawal') {
                const user = await User.findById(txn.userId);
                user.balance += txn.amount;
                await user.save();
                await new Notification({ userId: user._id, title: "Withdrawal Rejected", message: `Your withdrawal of ${txn.amount} ${txn.currency} was rejected. Funds returned.` }).save();
            }
        }
        await txn.save();
        res.status(200).json({ message: `Transaction ${action}d` });
    } catch (err) { res.status(500).send(); }
});

app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matches = await Match.find().sort({ startTime: -1 }).limit(500);
        res.status(200).json(matches);
    } catch (err) { res.status(500).send(); }
});

app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matchesData = Array.isArray(req.body) ? req.body : [req.body];
        let savedMatches = [];

        for (let matchData of matchesData) {
            const parsedStart = new Date(matchData.startTime);
            if (isNaN(parsedStart.getTime())) continue;

            const newMatch = new Match({
                ...matchData, status: 'upcoming', isLive: false, startTime: parsedStart,
                timezone: matchData.timezone || 'UTC', markets: matchData.markets || {}, result: matchData.result || null
            });
            await newMatch.save();
            savedMatches.push(newMatch);
        }

        res.status(201).json({ message: `${savedMatches.length} Matches injected`, matches: savedMatches });
    } catch (err) { 
        res.status(500).send(); 
    }
});

app.delete('/api/admin/matches/:id', verifyAdminToken, async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        res.status(200).send();
    } catch (err) { res.status(500).send(); }
});

app.get('/api/admin/bets', verifyAdminToken, async (req, res) => {
    try {
        const bets = await Bet.find().populate('userId', 'username phone').sort({ date: -1 });
        res.status(200).json(bets);
    } catch (err) { res.status(500).send(); }
});

app.put('/api/admin/bets/:id/cancel', verifyAdminToken, async (req, res) => {
    try {
        const bet = await Bet.findById(req.params.id);
        if (!bet || (bet.status !== 'Open' && bet.status !== 'Partial' && bet.status !== 'In Play')) return res.status(400).send();

        bet.status = 'Cancelled';
        await bet.save();

        const user = await User.findById(bet.userId);
        if (user) { user.balance += bet.stake; await user.save(); }
        res.status(200).send();
    } catch (err) { res.status(500).send(); }
});

app.put('/api/admin/matches/:id/result', verifyAdminToken, async (req, res) => {
    try {
        const { score, finalScore, result, isLive, status } = req.body;
        const updateData = {};

        if (score !== undefined) updateData.score = score;
        if (finalScore !== undefined) updateData.finalScore = finalScore;

        if (result !== undefined) {
            if (typeof result === 'string' && result.includes('-')) {
                const [h, a] = result.split('-').map(s => parseInt(s.trim()));
                updateData.result = { homeGoals: h || 0, awayGoals: a || 0, correctScore: result, winner: h > a ? 'home' : a > h ? 'away' : 'draw' };
            } else if (typeof result === 'object' && result !== null) {
                const h = parseInt(result.homeGoals);
                const a = parseInt(result.awayGoals);
                updateData.result = { homeGoals: isNaN(h) ? 0 : h, awayGoals: isNaN(a) ? 0 : a, correctScore: result.correctScore || `${h}-${a}`, btts: result.btts, winner: result.winner || (h > a ? 'home' : a > h ? 'away' : 'draw') };
            } else { updateData.result = result; }
        }

        if (!updateData.result && (finalScore || score)) {
            const scoreStr = finalScore || score;
            if (typeof scoreStr === 'string' && scoreStr.includes('-')) {
                const [h, a] = scoreStr.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(h) && !isNaN(a)) {
                    updateData.result = { homeGoals: h, awayGoals: a, correctScore: scoreStr, winner: h > a ? 'home' : a > h ? 'away' : 'draw' };
                }
            }
        }

        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ error: "Match not found" });

        const now = new Date().getTime();
        const start = new Date(match.startTime).getTime();
        const elapsed = now - start;
        const duration = 115 * 60 * 1000;

        if (elapsed < 0) { updateData.status = 'upcoming'; updateData.isLive = false; } 
        else if (elapsed >= 0 && elapsed < duration) { updateData.status = 'live'; updateData.isLive = true; } 
        else {
            if (isLive !== undefined) updateData.isLive = isLive;
            if (status !== undefined) updateData.status = status;
        }

        const updatedMatch = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.status(200).json({ message: "Result updated", match: updatedMatch });
    } catch (err) { res.status(500).send(); }
});

// ==========================================
// BACKGROUND SETTLEMENT WORKERS
// ==========================================

setInterval(async () => {
    try {
        const now = new Date();
        await Match.updateMany(
            { status: 'upcoming', startTime: { $lte: now } },
            { $set: { status: 'live', isLive: true } }
        );
        const twoHoursAgo = new Date(now.getTime() - (120 * 60 * 1000));
        await Match.updateMany(
            { status: 'live', startTime: { $lte: twoHoursAgo } },
            { $set: { status: 'completed', isLive: false } }
        );
    } catch (err) {}
}, 60000);

setInterval(async () => {
    try {
        const openBets = await Bet.find({
            status: { $in: ['Open', 'In Play', 'Partial'] }
        }).populate('userId');

        const now = new Date();

        for (let bet of openBets) {
            let betUpdated = false, allSettled = true, hasLost = false;

            for (let leg of bet.legs) {
                if (leg.status !== 'Open' && leg.status !== 'In Play') {
                    if (leg.status === 'Lost') hasLost = true;
                    continue;
                }

                const settlementTime = new Date(new Date(leg.startTime).getTime() + (120 * 60 * 1000));
                if (now < settlementTime) { allSettled = false; continue; }

                let matchResult = null;
                try {
                    if (mongoose.Types.ObjectId.isValid(leg.matchId)) matchResult = await Match.findById(leg.matchId);
                    if (!matchResult && leg.match) matchResult = await Match.findOne({ home: leg.match.split(' v ')[0], startTime: leg.startTime });
                } catch (e) {}

                let resultObj = null;
                if (matchResult) {
                    if (matchResult.result && matchResult.result.homeGoals !== undefined && matchResult.result.awayGoals !== undefined) {
                        resultObj = matchResult.result;
                    } else {
                        const scoreStr = matchResult.finalScore || matchResult.score || getCurrentScore(matchResult._id.toString(), matchResult.startTime, null);
                        if (typeof scoreStr === 'string' && scoreStr.includes('-')) {
                            const parts = scoreStr.split('-').map(s => parseInt(s.trim()));
                            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                                resultObj = { homeGoals: parts[0], awayGoals: parts[1], correctScore: scoreStr };
                            }
                        }
                    }
                }

                let isWin = false;
                const pickStr = (leg.pick || '').toString().trim().toUpperCase();
                const selStr = (leg.selection || '').toString().trim().toUpperCase();
                
                const homeTeam = (leg.match || '').split(' vs ')[0]?.trim().toUpperCase();
                const awayTeam = (leg.match || '').split(' vs ')[1]?.trim().toUpperCase();

                if (resultObj) {
                    const hG = parseInt(resultObj.homeGoals) || 0;
                    const aG = parseInt(resultObj.awayGoals) || 0;
                    const total = hG + aG;
                    const bothScored = (hG > 0 && aG > 0);

                    // ============================================
                    // FIXED CORRECT SCORE REGEX PARSER
                    // ============================================
                    const csMatch = pickStr.match(/\d+-\d+/) || selStr.match(/\d+-\d+/);

                    if (csMatch) { 
                        isWin = (csMatch[0] === `${hG}-${aG}`); 
                    } 
                    else if (pickStr.includes('OVER') || pickStr.includes('UNDER') || selStr.includes('OVER') || selStr.includes('UNDER')) {
                        const matchNum = pickStr.match(/\d+(\.\d+)?/) || selStr.match(/\d+(\.\d+)?/);
                        if (matchNum) {
                            const line = parseFloat(matchNum[0]);
                            if ((pickStr.includes('OVER') || selStr.includes('OVER')) && total > line) isWin = true;
                            if ((pickStr.includes('UNDER') || selStr.includes('UNDER')) && total < line) isWin = true;
                        }
                    } else if (pickStr.includes('1X') || selStr.includes('1X')) { isWin = hG >= aG; } 
                    else if (pickStr.includes('X2') || selStr.includes('X2')) { isWin = aG >= hG; } 
                    else if (pickStr.includes('12') || selStr.includes('12')) { isWin = hG !== aG; } 
                    else if (selStr.includes('BTTS') || pickStr.includes('BTTS YES') || pickStr.includes('BTTS NO') || pickStr === 'YES' || pickStr === 'NO') {
                        if ((pickStr.includes('YES') || selStr.includes('YES')) && bothScored) isWin = true;
                        if ((pickStr.includes('NO') || selStr.includes('NO')) && !bothScored) isWin = true;
                    } else if (pickStr === 'ODD' || selStr === 'ODD') { isWin = (total % 2 !== 0); } 
                    else if (pickStr === 'EVEN' || selStr === 'EVEN') { isWin = (total % 2 === 0); } 
                    else {
                        if ((pickStr === '1' || pickStr === homeTeam || selStr === '1' || pickStr.includes('HOME')) && hG > aG) isWin = true;
                        else if ((pickStr === 'X' || pickStr === 'DRAW' || selStr.includes('DRAW')) && hG === aG) isWin = true;
                        else if ((pickStr === '2' || pickStr === awayTeam || selStr === '2' || pickStr.includes('AWAY')) && aG > hG) isWin = true;
                    }
                } else {
                    isWin = Math.random() > 0.5;
                }

                leg.status = isWin ? 'Won' : 'Lost';
                leg.finalScore = matchResult ? (matchResult.finalScore || matchResult.score || `${resultObj?.homeGoals || 0}-${resultObj?.awayGoals || 0}`) : null;
                betUpdated = true;
                if (leg.status === 'Lost') hasLost = true;
            }

            if (hasLost) { bet.status = 'Lost'; betUpdated = true; } 
            else if (allSettled) {
                bet.status = 'Won'; betUpdated = true;
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance += bet.potentialReturn;
                    await user.save();
                    await Transaction.create({ userId: user._id, type: 'Win', amount: bet.potentialReturn, currency: bet.currency, status: 'Success' });
                    await new Notification({ userId: user._id, title: "Bet Won! 🎉", message: `Your bet ${bet.ticketId} won! ${bet.potentialReturn} ${bet.currency} credited.` }).save();
                }
            } else if (betUpdated) { bet.status = 'Partial'; }

            if (betUpdated) { bet.markModified('legs'); await bet.save(); }
        }
    } catch (err) { console.error('Settlement error:', err); }
}, 60000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Nalabets server running on port ${PORT}`));