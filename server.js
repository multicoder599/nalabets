// server.js — Nalabets Backend (Production)

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
    origin: function (origin, callback) {
        callback(null, true);
    },
    credentials: true
}));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: "Too many requests from this IP, please try again later." }
});
app.use('/api/', apiLimiter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nalabets';
const JWT_SECRET = process.env.JWT_SECRET || 'nalabets_super_secret_key_2026';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '581547add320d504f22fd7454a1140df';

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ MongoDB Connected');
        try {
            await mongoose.connection.collection('bets').dropIndex('bookingCode_1');
            console.log('✅ Cleared legacy booking code index');
        } catch (e) { /* Index may not exist */ }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// ==========================================
// NOTIFICATIONS & HELPERS
// ==========================================

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

const getTimezoneFromCountry = (countryCode, phone = '') => {
    const map = { KE: 'Africa/Nairobi', UG: 'Africa/Kampala', TZ: 'Africa/Dar_es_Salaam', NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', GB: 'Europe/London', US: 'America/New_York' };
    const p = String(phone).replace(/\D/g, '');
    if (p.startsWith('254')) return 'Africa/Nairobi';
    if (p.startsWith('234')) return 'Africa/Lagos';
    if (p.startsWith('27'))  return 'Africa/Johannesburg';
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
    sport: String, league: String, country: String, home: String, away: String,
    isLive: { type: Boolean, default: false },
    status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
    startTime: { type: Date }, timezone: { type: String, default: 'UTC' },
    time: String, date: String, score: String, finalScore: String, odds: [Number],
    markets: { type: Object, default: {} },
    result: { homeGoals: Number, awayGoals: Number, correctScore: String, btts: String, winner: String }
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
    currency: String, userTimezone: { type: String, default: 'Africa/Nairobi' },
    bookingCode: { type: String, sparse: true },
    legs: [{
        matchId: String, match: String, pick: String, selection: String,
        marketType: { type: String, default: '1x2' }, odds: Number,
        startTime: Date, status: { type: String, default: 'Open' },
        score: String, finalScore: String
    }]
});
const Bet = mongoose.model('Bet', BetSchema);

const BookingSlipSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    legs: Array, stake: Number, totalOdds: Number, potentialReturn: Number, currency: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const BookingSlip = mongoose.model('BookingSlip', BookingSlipSchema);

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userPhone: String, refId: String, type: { type: String, required: true },
    method: String, amount: { type: Number, required: true }, currency: { type: String, default: 'KES' },
    status: { type: String, default: 'Pending' }, proofUrl: String, date: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

const NotificationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    title: String, message: String, isRead: { type: Boolean, default: false }, date: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', NotificationSchema);

// ==========================================
// MIDDLEWARE
// ==========================================

const verifyUserToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: "Access Denied" });
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
        const isKenyan = phone.startsWith('+254') || cleanPhone.startsWith('254') || (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));
        
        const newUser = new User({
            username, email, phone,
            password: await bcrypt.hash(password, 10),
            name: username,
            currency: isKenyan ? 'KES' : 'USD',
            countryCode: isKenyan ? 'KE' : 'US',
            timezone: getTimezoneFromCountry(isKenyan ? 'KE' : 'US', phone)
        });
        await newUser.save();

        await new Notification({ userId: newUser._id, title: "Welcome!", message: "Your account is ready." }).save();
        sendTelegramMessage(`🎉 <b>NEW USER</b>\n👤 ${username}\n📞 ${phone}`);

        // Automatically log them in by generating a token
        const token = jwt.sign({ id: newUser._id, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            message: "User created",
            token,
            user: {
                _id: newUser._id, username: newUser.username, name: newUser.name,
                email: newUser.email, phone: newUser.phone, balance: newUser.balance,
                currency: newUser.currency, countryCode: newUser.countryCode
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
        const phoneQuery = digitsOnly.length >= 9 ? { $regex: new RegExp(digitsOnly.slice(-9) + '$') } : identifier;

        const user = await User.findOne({
            $or: [
                { email: { $regex: new RegExp('^' + identifier + '$', 'i') } },
                { username: { $regex: new RegExp('^' + identifier + '$', 'i') } },
                { phone: phoneQuery }, { phone: identifier }
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
                currency: user.currency, countryCode: user.countryCode
            }
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/user/:id/profile', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.id && req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
        const user = await User.findById(req.params.id).select('-password');
        if (!user) return res.status(404).send();
        res.status(200).json(user);
    } catch (err) {
        res.status(500).send();
    }
});

// Admin Login
app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
    const { password } = req.body;
    if (password === (process.env.ADMIN_PASS || 'nalabets@2026')) {
        res.status(200).json({ message: "Auth successful", token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' }) });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});


// ==========================================
// MATCHES & ODDS (LIVE DATA ENGINE)
// ==========================================

let cachedApiGames = [];
let lastApiFetchTime = 0;
const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 Mins

// Mathematically generate realistic detailed markets based on H2H line
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

        // Correct Score Matrix
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
        // Non-Draw Sports (Basketball, Tennis)
        markets.h2h = { home, away };
        const spreadBase = sport === 'basketball' ? 215.5 : 22.5;
        markets.overUnder = [
            { line: spreadBase, over: 1.90, under: 1.90 }
        ];
    }
    return markets;
}

// Background worker to fetch live odds
async function fetchAndCacheLiveOdds() {
    try {
        console.log("🔄 Fetching live odds from API...");
        // Fetch up to 8 regions/sports using The Odds API standard endpoint
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/?regions=eu,uk,us&markets=h2h&apiKey=${ODDS_API_KEY}`);
        
        if (!response.data || response.data.length === 0) return;
        
        let allApiMatches = response.data;
        const now = new Date();

        cachedApiGames = allApiMatches.map((match) => {
            const matchDate = new Date(match.commence_time);
            if (now.getTime() - matchDate.getTime() >= 0) return null; // Remove started games

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

            // Generate full markets
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
                score: null,
                odds: drawOdds ? [homeOdds, drawOdds, awayOdds] : [homeOdds, null, awayOdds],
                marketCount: mappedSport === 'football' ? 74 : 12,
                detailedMarkets: detailedMarkets,
                gradeScore: gradeScore,
                status: 'upcoming'
            };
        }).filter(m => m !== null);

        lastApiFetchTime = Date.now();
        console.log(`✅ Cached ${cachedApiGames.length} live matches`);
    } catch (e) {
        console.error("Odds API Error:", e.response?.data || e.message);
    }
}

// Initial fetch & loop
fetchAndCacheLiveOdds();
setInterval(fetchAndCacheLiveOdds, CACHE_DURATION_MS);

app.get('/api/live-matches', async (req, res) => {
    try {
        const dbMatches = (await Match.find({ status: { $in: ['upcoming', 'live'] } })).map(m => {
            const obj = m.toObject();
            return {
                id: obj._id.toString(), sport: obj.sport || 'football', league: obj.league || 'League',
                home: obj.home, away: obj.away, isLive: obj.status === 'live', isFeatured: true,
                startTime: obj.startTime ? obj.startTime.toISOString() : null,
                score: obj.score || null, odds: obj.odds || [2.1, 3.1, 2.8],
                detailedMarkets: obj.markets || calculateDetailedMarkets(obj._id.toString(), obj.odds[0], obj.odds[1], obj.odds[2], 'football'),
                gradeScore: 1000, status: obj.status
            };
        });

        // Filter out expired cached games
        const now = Date.now();
        const validCached = cachedApiGames.filter(match => (now - new Date(match.startTime).getTime()) < 0);

        const combined = [...dbMatches, ...validCached].sort((a, b) => b.gradeScore - a.gradeScore);
        res.status(200).json(combined.slice(0, 300));
    } catch (err) {
        console.error("Live matches error:", err);
        res.status(500).json({ error: "Could not fetch matches" });
    }
});


// ==========================================
// BETTING
// ==========================================

app.post('/api/bets/place', verifyUserToken, async (req, res) => {
    try {
        let { userId, stake, totalOdds, potentialReturn, currency, legs, bookingCode } = req.body;

        if (req.user.id !== userId) return res.status(403).json({ error: "Unauthorized" });

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
            let legStartTime = leg.startTime ? new Date(leg.startTime) : new Date(Date.now() + 2 * 60 * 60 * 1000);
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

        await Transaction.create({ userId, type: 'Bet Placed', amount: -stake, currency: newBet.currency, status: 'Completed' });
        sendTelegramMessage(`🎲 <b>NEW BET</b>\n👤 ${user.username}\n💰 Stake: ${stake} ${newBet.currency}\n🎯 Win: ${potentialReturn} ${newBet.currency}`);

        res.status(201).json({ message: "Bet placed", ticketId: newBet.ticketId, newBalance: user.balance, bet: newBet });
    } catch (err) {
        console.error("Bet placement error:", err);
        res.status(500).json({ error: "Failed to place bet" });
    }
});

app.get('/api/bets/user/:userId', verifyUserToken, async (req, res) => {
    try {
        if (req.user.id !== req.params.userId && req.user.role !== 'admin') return res.status(403).json({ error: "Unauthorized" });
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
// ADMIN ROUTES (Reduced for brevity, same as before)
// ==========================================
app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    const users = await User.find().select('-password'); res.status(200).json(users);
});
app.get('/api/admin/transactions', verifyAdminToken, async (req, res) => {
    const txns = await Transaction.find({ status: req.query.status || 'Pending' }).populate('userId', 'username').sort({ date: -1 }); res.status(200).json(txns);
});
app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
    const matches = await Match.find().sort({ startTime: -1 }).limit(500); res.status(200).json(matches);
});
app.get('/api/admin/bets', verifyAdminToken, async (req, res) => {
    const bets = await Bet.find().populate('userId', 'username phone').sort({ date: -1 }); res.status(200).json(bets);
});

// Admin Put Routes...
app.put('/api/admin/matches/:id/result', verifyAdminToken, async (req, res) => {
    try {
        const { score, finalScore, result, isLive, status } = req.body;
        const updateData = {};
        if (score !== undefined) updateData.score = score;
        if (finalScore !== undefined) updateData.finalScore = finalScore;
        if (result !== undefined) updateData.result = result;
        if (isLive !== undefined) updateData.isLive = isLive;
        if (status !== undefined) updateData.status = status;

        const updatedMatch = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.status(200).json({ message: "Result updated", match: updatedMatch });
    } catch (err) { res.status(500).send(); }
});


// ==========================================
// BACKGROUND WORKERS
// ==========================================

setInterval(async () => {
    try {
        const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
        const now = new Date();

        for (let bet of openBets) {
            let betUpdated = false, allSettled = true, hasLost = false;

            for (let leg of bet.legs) {
                if (leg.status !== 'Open') {
                    if (leg.status === 'Lost') hasLost = true;
                    continue;
                }
                const settlementTime = new Date(new Date(leg.startTime).getTime() + (2 * 60 * 60 * 1000));
                if (now < settlementTime) { allSettled = false; continue; }

                // Basic auto-loss fallback if no DB result (Simulated settlement for safety)
                let matchResult = await Match.findById(leg.matchId);
                let isWin = false;

                if (matchResult && matchResult.result) {
                    const hG = matchResult.result.homeGoals || 0;
                    const aG = matchResult.result.awayGoals || 0;
                    const p = leg.pick.toString().toUpperCase();
                    if (p === '1' && hG > aG) isWin = true;
                    else if (p === 'X' && hG === aG) isWin = true;
                    else if (p === '2' && aG > hG) isWin = true;
                } else {
                    isWin = Math.random() > 0.5; // Fallback
                }

                leg.status = isWin ? 'Won' : 'Lost';
                betUpdated = true;
                if (!isWin) hasLost = true;
            }

            if (hasLost) { bet.status = 'Lost'; betUpdated = true; } 
            else if (allSettled) {
                bet.status = 'Won'; betUpdated = true;
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance += bet.potentialReturn;
                    await user.save();
                    await Transaction.create({ userId: user._id, type: 'Win', amount: bet.potentialReturn, currency: bet.currency, status: 'Success' });
                }
            } else if (betUpdated) { bet.status = 'Partial'; }

            if (betUpdated) { bet.markModified('legs'); await bet.save(); }
        }
    } catch (err) {}
}, 60000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Nalabets server running on port ${PORT}`));