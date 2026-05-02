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

// CORS
app.use(cors({
    origin: function (origin, callback) {
        callback(null, true);
    },
    credentials: true
}));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: "Too many requests from this IP, please try again later." }
});
app.use('/api/', apiLimiter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nalabets';

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
    markets: {
        h2h: { home: Number, draw: Number, away: Number },
        correctScore: [{ score: String, odds: Number }],
        overUnder: [{ line: Number, over: Number, under: Number }],
        btts: { yes: Number, no: Number },
        doubleChance: { '1x': Number, x2: Number, '12': Number }
    },
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
    status: { type: String, default: 'Open', enum: ['Open', 'Partial', 'Won', 'Lost', 'Cancelled'] },
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
    createdAt: { type: Date, default: Date.now, expires: 86400 }
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

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_insecure_secret';

// Admin Middleware
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
            api_key: process.env.MEGAPAY_API_KEY || 'MGPYCVoPXv2P',
            email: process.env.MEGAPAY_EMAIL || 'gleah6423@gmail.com',
            amount: amount,
            msisdn: formattedPhone,
            callback_url: `${process.env.APP_URL || 'https://nalabets.onrender.com'}/api/megapay/webhook`,
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
            message: `Your deposit of KES ${amount} has been credited. Receipt: ${receipt}`
        }).save();
        sendTelegramMessage(`💵 <b>DEPOSIT</b>\n📱 ${user.phone}\n💰 KES ${amount}\n🧾 ${receipt}`);
    } catch (err) {
        console.error('Webhook error:', err);
    }
});

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
            username,
            email,
            phone,
            password: await bcrypt.hash(password, 10),
            name: username,
            currency,
            countryCode,
            timezone
        });
        await newUser.save();

        await new Notification({
            userId: newUser._id,
            title: "Welcome!",
            message: "Your account is ready."
        }).save();
        sendTelegramMessage(`🎉 <b>NEW USER</b>\n👤 ${username}\n📞 ${phone}`);

        res.status(201).json({
            message: "User created",
            user: {
                _id: newUser._id,
                username: newUser.username,
                name: newUser.name,
                email: newUser.email,
                phone: newUser.phone,
                balance: newUser.balance,
                currency: newUser.currency,
                countryCode: newUser.countryCode,
                timezone: newUser.timezone,
                oddsFormat: newUser.oddsFormat,
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

        res.status(200).json({
            message: "Login successful",
            user: {
                _id: user._id,
                username: user.username,
                name: user.name,
                email: user.email,
                phone: user.phone,
                balance: user.balance,
                currency: user.currency,
                countryCode: user.countryCode,
                timezone: user.timezone,
                oddsFormat: user.oddsFormat,
                cryptoAddresses: getCryptoAddresses()
            }
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/user/:id/profile', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (!user) return res.status(404).send();
        const payload = user.toObject();
        payload.cryptoAddresses = getCryptoAddresses();
        res.status(200).json(payload);
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/user/:id/notifications', async (req, res) => {
    try {
        const notifs = await Notification.find({
            $or: [{ userId: req.params.id }, { userId: null }]
        }).sort({ date: -1 }).limit(20);
        res.status(200).json(notifs);
    } catch (err) {
        res.status(500).send();
    }
});

// ==========================================
// WALLET
// ==========================================

app.post('/api/wallet/deposit/manual', async (req, res) => {
    try {
        const { userId, amount, currency, method, proofSubmitted } = req.body;
        const user = await User.findById(userId);
        if (!user) return res.status(404).send();

        await Transaction.create({
            userId,
            type: 'Deposit',
            method,
            amount,
            currency,
            status: 'Pending',
            proofUrl: proofSubmitted ? 'Proof Submitted' : 'Pending'
        });
        sendTelegramMessage(`⏳ <b>MANUAL DEPOSIT</b>\n👤 ${user.username}\n💳 ${method}\n💰 ${amount} ${currency}`);
        res.status(200).json({ message: "Deposit requested", balance: user.balance });
    } catch (err) {
        res.status(500).send();
    }
});

app.post('/api/wallet/withdraw', async (req, res) => {
    try {
        const { userId, amount, currency, accountDetails } = req.body;
        const user = await User.findById(userId);
        if (!user || user.balance < amount) return res.status(400).send();

        user.balance -= parseFloat(amount);
        await user.save();
        await Transaction.create({
            userId,
            type: 'Withdrawal',
            amount,
            currency,
            status: 'Pending'
        });
        sendTelegramMessage(`💸 <b>WITHDRAWAL</b>\n👤 ${user.username}\n💳 ${accountDetails}\n💰 ${amount} ${currency}`);
        res.status(200).json({ message: "Withdrawal requested", balance: user.balance });
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/wallet/transactions/:userId', async (req, res) => {
    try {
        const txns = await Transaction.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) {
        res.status(500).send();
    }
});

// ==========================================
// MATCHES & ODDS
// ==========================================

const ODDS_API_KEY = process.env.ODDS_API_KEY || '581547add320d504f22fd7454a1140df';

let cachedApiGames = [];
let lastApiFetchTime = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000;

function getMatchTimeStr(startTimeStr) {
    if (!startTimeStr) return "";
    const elapsedMs = new Date().getTime() - new Date(startTimeStr).getTime();
    const elapsedMins = Math.floor(elapsedMs / 60000);
    if (elapsedMins < 0) return "Upcoming";
    if (elapsedMins <= 45) return `${elapsedMins}'`;
    if (elapsedMins > 45 && elapsedMins <= 50) return `45+${elapsedMins - 45}'`;
    if (elapsedMins > 50 && elapsedMins <= 65) return "HT";
    if (elapsedMins > 65 && elapsedMins <= 110) return `${45 + (elapsedMins - 65)}'`;
    if (elapsedMins > 110 && elapsedMins <= 116) return `90+${elapsedMins - 110}'`;
    if (elapsedMins > 116 && elapsedMins < 120) return "Settling...";
    return "FT";
}

function getDeterministicScore(matchId, startTimeStr, adminResultObj) {
    const start = new Date(startTimeStr).getTime();
    const now = new Date().getTime();
    const elapsed = now - start;
    if (elapsed < 0) return null;

    const duration = 116 * 60 * 1000;
    const progress = Math.min(elapsed / duration, 1);

    if (adminResultObj && adminResultObj.homeGoals !== undefined) {
        return `${Math.floor(adminResultObj.homeGoals * progress)}-${Math.floor(adminResultObj.awayGoals * progress)}`;
    }

    let seed = 0;
    for (let i = 0; i < matchId.length; i++) seed += matchId.charCodeAt(i);
    const maxHome = seed % 4;
    const maxAway = (seed * 3) % 4;
    return `${Math.floor(maxHome * progress)}-${Math.floor(maxAway * progress)}`;
}

app.get('/api/matches', async (req, res) => {
    try {
        const dbMatches = await Match.find({
            status: { $in: ['upcoming', 'live'] }
        }).sort({ startTime: 1 });

        const formatted = dbMatches.map(m => {
            const obj = m.toObject();
            obj.startTime = m.startTime ? m.startTime.toISOString() : null;
            obj.markets = m.markets || {};
            if (obj.status === 'live' && obj.startTime) {
                obj.score = getDeterministicScore(obj._id.toString(), obj.startTime, obj.result);
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
        const now = new Date();

        let dbMatches = [];
        try {
            dbMatches = (await Match.find({ status: { $in: ['upcoming', 'live'] } })).map(m => ({
                id: m._id.toString(),
                sport: m.sport || 'football',
                region: 'Custom',
                league: m.league || 'League',
                country: m.country || 'gb-eng',
                home: m.home,
                away: m.away,
                isLive: m.status === 'live',
                isFeatured: true,
                startTime: m.startTime ? m.startTime.toISOString() : null,
                time: m.status === 'live' ? getMatchTimeStr(m.startTime) : null,
                score: m.status === 'live' ? getDeterministicScore(m._id.toString(), m.startTime, m.result) : null,
                finalScore: m.finalScore || null,
                odds: m.odds || [2.1, 3.1, 2.8],
                marketCount: m.markets ? (Object.keys(m.markets).length * 5 + 20) : 50,
                gradeScore: 1000,
                detailedMarkets: m.markets || {},
                status: m.status,
                result: m.result || null
            }));
        } catch (e) {}

        if (now.getTime() - lastApiFetchTime < CACHE_DURATION_MS && cachedApiGames.length > 0) {
            cachedApiGames = cachedApiGames.filter(match => {
                const matchDate = new Date(match.startTime);
                return (now.getTime() - matchDate.getTime()) < 0;
            });
            const combined = [...dbMatches, ...cachedApiGames].sort((a, b) => b.gradeScore - a.gradeScore);
            return res.status(200).json(combined.slice(0, 500));
        }

        const tomorrow = new Date();
        tomorrow.setDate(now.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        const nextWeek = new Date();
        nextWeek.setDate(now.getDate() + 7);

        const fromDate = tomorrow.toISOString().split('.')[0] + 'Z';
        const toDate = nextWeek.toISOString().split('.')[0] + 'Z';

        const sportsToFetch = [
            'soccer_epl', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_italy_serie_a',
            'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_england_championship',
            'soccer_england_league_1', 'soccer_england_league_2', 'soccer_netherlands_eredivisie',
            'soccer_portugal_primeira_liga', 'soccer_turkey_super_lig', 'soccer_brazil_campeonato', 'soccer_usa_mls',
            'basketball_nba', 'basketball_euroleague', 'basketball_ncaab',
            'tennis_atp', 'tennis_wta', 'icehockey_nhl',
            'mma_mixed_martial_arts', 'americanfootball_nfl', 'baseball_mlb'
        ];

        let allApiMatches = [];

        await Promise.all(sportsToFetch.map(async (sportKey) => {
            try {
                const response = await axios.get(
                    `https://parlay-api.com/v1/sports/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=uk,eu,us&markets=h2h,spreads&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`
                );
                if (response.data) allApiMatches = allApiMatches.concat(response.data);
            } catch (e) {}
        }));

        let formattedMatches = allApiMatches.map((match) => {
            let matchDate = new Date(match.commence_time);
            if (match.commence_time && match.commence_time.includes('19:00:00Z')) {
                let seed = 0;
                for (let i = 0; i < match.id.length; i++) seed += match.id.charCodeAt(i);
                const hourOffset = seed % 6;
                const minuteOffset = (seed % 2) === 0 ? 30 : 0;
                matchDate.setUTCHours(12 + hourOffset, minuteOffset, 0, 0);
            }

            const elapsed = now.getTime() - matchDate.getTime();
            if (elapsed >= 0) return null;

            const market = match.bookmakers[0]?.markets[0];
            let homeOdds = 2.10, drawOdds = null, awayOdds = 2.80;

            if (market && market.outcomes) {
                const homeOutcome = market.outcomes.find(o => o.name === match.home_team);
                const awayOutcome = market.outcomes.find(o => o.name === match.away_team);
                const drawOutcome = market.outcomes.find(o => o.name === 'Draw' ||
                    (o.name !== match.home_team && o.name !== match.away_team));

                if (homeOutcome) homeOdds = homeOutcome.price;
                if (awayOutcome) awayOdds = awayOutcome.price;
                if (drawOutcome) drawOdds = drawOutcome.price;
            }

            let mappedSport = 'football';
            if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
            if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
            if (match.sport_key.includes('mma')) mappedSport = 'mma';
            if (match.sport_key.includes('icehockey')) mappedSport = 'icehockey';
            if (match.sport_key.includes('americanfootball')) mappedSport = 'rugby';
            if (match.sport_key.includes('baseball')) mappedSport = 'baseball';

            if (mappedSport === 'football' && !drawOdds) {
                drawOdds = parseFloat(((homeOdds + awayOdds) / 1.5).toFixed(2));
                if (drawOdds < 2.5) drawOdds = 3.10;
            }

            let leagueName = match.sport_title || 'League';
            if (match.sport_key === 'soccer_germany_bundesliga') leagueName = 'Bundesliga';
            if (match.sport_key === 'soccer_spain_la_liga') leagueName = 'La Liga';
            if (match.sport_key === 'soccer_italy_serie_a') leagueName = 'Serie A';
            if (match.sport_key === 'soccer_france_ligue_one') leagueName = 'Ligue 1';
            if (match.sport_key === 'soccer_epl') leagueName = 'Premier League';

            let countryCode = 'gb-eng';
            if (match.sport_key.includes('germany')) countryCode = 'de';
            else if (match.sport_key.includes('spain')) countryCode = 'es';
            else if (match.sport_key.includes('italy')) countryCode = 'it';
            else if (match.sport_key.includes('france')) countryCode = 'fr';
            else if (match.sport_key.includes('portugal')) countryCode = 'pt';
            else if (match.sport_key.includes('netherlands')) countryCode = 'nl';
            else if (match.sport_key.includes('brazil')) countryCode = 'br';
            else if (match.sport_key.includes('turkey')) countryCode = 'tr';
            else if (match.sport_key.includes('usa') || mappedSport !== 'football') countryCode = 'us';

            let gradeScore = 0;
            if (mappedSport === 'football') gradeScore += 50;
            if (match.sport_key.includes('champs_league') || match.sport_key.includes('epl')) gradeScore += 75;

            return {
                id: 'api_' + match.id,
                sport: mappedSport,
                region: 'Global',
                league: leagueName,
                country: countryCode,
                home: match.home_team,
                away: match.away_team,
                isLive: false,
                isFeatured: gradeScore > 50,
                startTime: matchDate.toISOString(),
                score: null,
                odds: [homeOdds, drawOdds, awayOdds],
                marketCount: Math.floor(Math.random() * 150) + 30,
                gradeScore: gradeScore,
                status: 'upcoming',
                result: null,
                finalScore: null
            };
        }).filter(m => m !== null);

        cachedApiGames = formattedMatches;
        lastApiFetchTime = now.getTime();

        const combined = [...dbMatches, ...cachedApiGames].sort((a, b) => b.gradeScore - a.gradeScore);
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

app.post('/api/bets/place', async (req, res) => {
    try {
        let { userId, stake, totalOdds, potentialReturn, currency, legs, bookingCode } = req.body;

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
                matchId: leg.matchId,
                match: leg.match,
                pick: leg.pick,
                selection: leg.selection,
                marketType: leg.marketType || '1x2',
                odds: parseFloat(leg.odds) || 0,
                startTime: legStartTime,
                status: 'Open',
                score: null,
                finalScore: null
            };
        }));

        const newBet = new Bet({
            userId: user._id,
            ticketId: "NB-" + Math.random().toString(36).substring(2, 8).toUpperCase(),
            bookingCode: bookingCode || undefined,
            stake,
            totalOdds,
            potentialReturn,
            currency: currency || user.currency,
            userTimezone: user.timezone || 'Africa/Nairobi',
            legs: trackedLegs
        });

        await newBet.save();

        user.balance -= stake;
        await user.save();

        await Transaction.create({
            userId,
            type: 'Bet Placed',
            amount: -stake,
            currency: newBet.currency,
            status: 'Completed'
        });
        sendTelegramMessage(`🎲 <b>NEW BET</b>\n👤 ${user.username}\n💰 Stake: ${stake} ${newBet.currency}\n🎯 Win: ${potentialReturn} ${newBet.currency}`);

        res.status(201).json({
            message: "Bet placed",
            ticketId: newBet.ticketId,
            newBalance: user.balance,
            bet: newBet
        });
    } catch (err) {
        console.error("Bet placement error:", err);
        res.status(500).json({ error: "Failed to place bet" });
    }
});

app.get('/api/bets/user/:userId', async (req, res) => {
    try {
        const bets = await Bet.find({ userId: req.params.userId }).sort({ date: -1 });
        res.status(200).json(bets);
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
    } catch (err) {
        res.status(500).send();
    }
});

app.put('/api/admin/users/:id/balance/set', verifyAdminToken, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        user.balance = parseFloat(req.body.amount);
        await user.save();
        res.status(200).json({ balance: user.balance });
    } catch (err) {
        res.status(500).send();
    }
});

app.delete('/api/admin/users/:id', verifyAdminToken, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.status(200).send();
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/admin/transactions', verifyAdminToken, async (req, res) => {
    try {
        const txns = await Transaction.find({
            status: req.query.status || 'Pending'
        }).populate('userId', 'username').sort({ date: -1 });
        res.status(200).json(txns);
    } catch (err) {
        res.status(500).send();
    }
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
                await new Notification({
                    userId: user._id,
                    title: "Deposit Approved",
                    message: `Your deposit of ${txn.amount} ${txn.currency} was approved.`
                }).save();
            }
        } else if (action === 'reject') {
            txn.status = 'Failed';
            if (txn.type === 'Withdrawal') {
                const user = await User.findById(txn.userId);
                user.balance += txn.amount;
                await user.save();
                await new Notification({
                    userId: user._id,
                    title: "Withdrawal Rejected",
                    message: `Your withdrawal of ${txn.amount} ${txn.currency} was rejected. Funds returned.`
                }).save();
            }
        }
        await txn.save();
        res.status(200).json({ message: `Transaction ${action}d` });
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matches = await Match.find().sort({ startTime: -1 }).limit(500);
        res.status(200).json(matches);
    } catch (err) {
        res.status(500).send();
    }
});

app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
    try {
        const matchData = req.body;
        const parsedStart = new Date(matchData.startTime);
        if (isNaN(parsedStart.getTime())) return res.status(400).send();

        const newMatch = new Match({
            ...matchData,
            status: 'upcoming',
            isLive: false,
            startTime: parsedStart,
            timezone: matchData.timezone || 'UTC',
            markets: matchData.markets || {},
            result: matchData.result || null
        });
        await newMatch.save();
        res.status(201).json({ message: "Match injected", match: newMatch });
    } catch (err) {
        res.status(500).send();
    }
});

app.delete('/api/admin/matches/:id', verifyAdminToken, async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        res.status(200).send();
    } catch (err) {
        res.status(500).send();
    }
});

app.get('/api/admin/bets', verifyAdminToken, async (req, res) => {
    try {
        const bets = await Bet.find()
            .populate('userId', 'username phone')
            .sort({ date: -1 });
        res.status(200).json(bets);
    } catch (err) {
        res.status(500).send();
    }
});

app.put('/api/admin/bets/:id/cancel', verifyAdminToken, async (req, res) => {
    try {
        const bet = await Bet.findById(req.params.id);
        if (!bet || (bet.status !== 'Open' && bet.status !== 'Partial')) return res.status(400).send();

        bet.status = 'Cancelled';
        await bet.save();

        const user = await User.findById(bet.userId);
        if (user) {
            user.balance += bet.stake;
            await user.save();
        }
        res.status(200).send();
    } catch (err) {
        res.status(500).send();
    }
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
                updateData.result = {
                    homeGoals: h || 0,
                    awayGoals: a || 0,
                    correctScore: result,
                    winner: h > a ? 'home' : a > h ? 'away' : 'draw'
                };
            } else if (typeof result === 'object' && result !== null) {
                const h = parseInt(result.homeGoals);
                const a = parseInt(result.awayGoals);
                updateData.result = {
                    homeGoals: isNaN(h) ? 0 : h,
                    awayGoals: isNaN(a) ? 0 : a,
                    correctScore: result.correctScore || `${h}-${a}`,
                    btts: result.btts,
                    winner: result.winner || (h > a ? 'home' : a > h ? 'away' : 'draw')
                };
            } else {
                updateData.result = result;
            }
        }

        if (!updateData.result && (finalScore || score)) {
            const scoreStr = finalScore || score;
            if (typeof scoreStr === 'string' && scoreStr.includes('-')) {
                const [h, a] = scoreStr.split('-').map(s => parseInt(s.trim()));
                if (!isNaN(h) && !isNaN(a)) {
                    updateData.result = {
                        homeGoals: h,
                        awayGoals: a,
                        correctScore: scoreStr,
                        winner: h > a ? 'home' : a > h ? 'away' : 'draw'
                    };
                }
            }
        }

        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ error: "Match not found" });

        const now = new Date().getTime();
        const start = new Date(match.startTime).getTime();
        const elapsed = now - start;
        const twoHours = 2 * 60 * 60 * 1000;

        if (elapsed < 0) {
            updateData.status = 'upcoming';
            updateData.isLive = false;
        } else if (elapsed >= 0 && elapsed < twoHours) {
            updateData.status = 'live';
            updateData.isLive = true;
        } else {
            if (isLive !== undefined) updateData.isLive = isLive;
            if (status !== undefined) updateData.status = status;
        }

        const updatedMatch = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.status(200).json({ message: "Result updated", match: updatedMatch });
    } catch (err) {
        res.status(500).send();
    }
});

// ==========================================
// BACKGROUND WORKERS
// ==========================================

setInterval(async () => {
    try {
        const now = new Date();
        await Match.updateMany(
            { status: 'upcoming', startTime: { $lte: now } },
            { $set: { status: 'live', isLive: true } }
        );
        const twoHoursAgo = new Date(now.getTime() - (2 * 60 * 60 * 1000));
        await Match.updateMany(
            { status: 'live', startTime: { $lte: twoHoursAgo } },
            { $set: { status: 'completed', isLive: false } }
        );
    } catch (err) {}
}, 60000);

setInterval(async () => {
    try {
        const openBets = await Bet.find({
            status: { $in: ['Open', 'Partial'] }
        }).populate('userId');

        const now = new Date();

        for (let bet of openBets) {
            let betUpdated = false;
            let allSettled = true;
            let hasLost = false;

            for (let leg of bet.legs) {
                if (leg.status !== 'Open') {
                    if (leg.status === 'Lost') hasLost = true;
                    continue;
                }

                const settlementTime = new Date(new Date(leg.startTime).getTime() + (2 * 60 * 60 * 1000));
                if (now < settlementTime) {
                    allSettled = false;
                    continue;
                }

                let matchResult = null;
                try {
                    if (mongoose.Types.ObjectId.isValid(leg.matchId)) {
                        matchResult = await Match.findById(leg.matchId);
                    }
                    if (!matchResult && leg.match) {
                        matchResult = await Match.findOne({
                            home: leg.match.split(' v ')[0],
                            startTime: leg.startTime
                        });
                    }
                } catch (e) {}

                let resultObj = null;
                if (matchResult) {
                    if (matchResult.result && matchResult.result.homeGoals !== undefined &&
                        matchResult.result.awayGoals !== undefined) {
                        resultObj = matchResult.result;
                    } else {
                        const scoreStr = matchResult.finalScore || matchResult.score;
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

                if (resultObj) {
                    const hG = parseInt(resultObj.homeGoals) || 0;
                    const aG = parseInt(resultObj.awayGoals) || 0;
                    const total = hG + aG;
                    const bothScored = (hG > 0 && aG > 0);

                    if (pickStr.match(/^\d+-\d+$/)) {
                        isWin = (pickStr === `${hG}-${aG}`);
                    } else if (pickStr.includes('OVER') || pickStr.includes('UNDER') ||
                               selStr.includes('OVER') || selStr.includes('UNDER')) {
                        const matchNum = pickStr.match(/\d+(\.\d+)?/) || selStr.match(/\d+(\.\d+)?/);
                        if (matchNum) {
                            const line = parseFloat(matchNum[0]);
                            if ((pickStr.includes('OVER') || selStr.includes('OVER')) && total > line) isWin = true;
                            if ((pickStr.includes('UNDER') || selStr.includes('UNDER')) && total < line) isWin = true;
                        }
                    } else if (pickStr === '1X' || selStr.includes('1X')) {
                        isWin = hG >= aG;
                    } else if (pickStr === 'X2' || selStr.includes('X2')) {
                        isWin = aG >= hG;
                    } else if (pickStr === '12' || selStr.includes('12')) {
                        isWin = hG !== aG;
                    } else if (selStr.includes('BTTS') || pickStr === 'YES' || pickStr === 'NO') {
                        if ((pickStr === 'YES' || selStr.includes('YES')) && bothScored) isWin = true;
                        if ((pickStr === 'NO' || selStr.includes('NO')) && !bothScored) isWin = true;
                    } else if (pickStr === 'ODD' || selStr === 'ODD') {
                        isWin = (total % 2 !== 0);
                    } else if (pickStr === 'EVEN' || selStr === 'EVEN') {
                        isWin = (total % 2 === 0);
                    } else {
                        if ((pickStr === '1' || selStr === '1' || pickStr.includes('HOME')) && hG > aG) isWin = true;
                        else if ((pickStr === 'X' || pickStr === 'DRAW' || selStr.includes('DRAW')) && hG === aG) isWin = true;
                        else if ((pickStr === '2' || selStr === '2' || pickStr.includes('AWAY')) && aG > hG) isWin = true;
                    }
                } else {
                    isWin = Math.random() > 0.5;
                }

                leg.status = isWin ? 'Won' : 'Lost';
                leg.finalScore = matchResult ? (matchResult.finalScore || matchResult.score ||
                    `${resultObj?.homeGoals || 0}-${resultObj?.awayGoals || 0}`) : null;
                betUpdated = true;
                if (leg.status === 'Lost') hasLost = true;
            }

            if (hasLost) {
                bet.status = 'Lost';
                betUpdated = true;
            } else if (allSettled) {
                bet.status = 'Won';
                betUpdated = true;
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance += bet.potentialReturn;
                    await user.save();
                    await Transaction.create({
                        userId: user._id,
                        type: 'Win',
                        amount: bet.potentialReturn,
                        currency: bet.currency,
                        status: 'Success'
                    });
                    await new Notification({
                        userId: user._id,
                        title: "Bet Won! 🎉",
                        message: `Your bet ${bet.ticketId} won! ${bet.potentialReturn} ${bet.currency} credited.`
                    }).save();
                }
            } else if (betUpdated) {
                bet.status = 'Partial';
            }

            if (betUpdated) {
                bet.markModified('legs');
                await bet.save();
            }
        }
    } catch (err) {
        console.error('Settlement error:', err);
    }
}, 60000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Nalabets server running on port ${PORT}`));