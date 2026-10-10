const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type'); 
const { sms, downloadMediaMessage } = require("./lib/msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const FIREBASE_URL = 'https://ves-mini-db-acc54-default-rtdb.asia-southeast1.firebasedatabase.app/';

const config = {
    BOT_NAME: 'ves-mini-bot',
    BOT_FOOTER: 'ᴅᴇᴠᴇʟᴏᴩᴇᴅ ʙʏ ɪꜱɪʀᴀ ɪɴᴅᴜᴡᴀʀᴀ',
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/xxxxxxx',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/vqt082.jpg',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94740544995',
    ADMIN_LIST_PATH: './lib/admin.json'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

const RECONNECT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const lastAutoReconnectAttempt = new Map();
const pendingAutoReconnect = new Map(); // number -> Timeout handle

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

function scheduleAutoReconnect(number, fn) {
    const cleanNumber = number.replace(/[^0-9]/g, '');
    const last = lastAutoReconnectAttempt.get(cleanNumber) || 0;
    const elapsed = Date.now() - last;
    
    if (pendingAutoReconnect.has(cleanNumber)) {
        // A reconnect is already scheduled for this number; don't stack another.
        return;
    }
    
    const runNow = () => {
        pendingAutoReconnect.delete(cleanNumber);
        lastAutoReconnectAttempt.set(cleanNumber, Date.now());
        fn();
    };
    
    if (elapsed >= RECONNECT_COOLDOWN_MS) {
        runNow();
    } else {
        const wait = RECONNECT_COOLDOWN_MS - elapsed;
        console.log(`⏳ Auto-reconnect for ${cleanNumber} throttled, next attempt in ${Math.ceil(wait / 60000)}m`);
        pendingAutoReconnect.set(cleanNumber, setTimeout(runNow, wait));
    }
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
                console.log(`Deleted duplicate session file: ${sessionKeys[i]}`);
            }
        }

        const configKey = `config_${sanitizedNumber}.json`;
        if (data[configKey]) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Load the admin numbers from the configured admin list
function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// Send a connection message to all admins
async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();

    const caption = formatMessage(
        config.BOT_NAME,
        `📞 Number: ${number}\n Status: Connected`,
        config.BOT_FOOTER
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        config.BOT_FOOTER
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            config.BOT_FOOTER
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const firebaseSessionPath = `session/creds_${sanitizedNumber}.json`; // Fixed variable
        const { data } = await axios.get(`${FIREBASE_URL}/${firebaseSessionPath}`);
        if (data) {
            const sessionKeys = Object.keys(data).filter(key =>
                key.includes(sanitizedNumber) && key.endsWith('.json')
            );
            for (const key of sessionKeys) {
                await axios.delete(`${FIREBASE_URL}/session/${key.replace('.json', '')}.json`);
                console.log(`Deleted Firebase session file: ${key}`);
            }
        }
        let numbers = [];
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (error) {
        console.error('Failed to delete session from Firebase:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${configKey}.json`);
        return data || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        await axios.put(`${FIREBASE_URL}/session/${configKey}.json`, newConfig);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionPath = `session/session_${sanitizedNumber}.json`;
        await axios.delete(`${FIREBASE_URL}/${sessionPath}`);
        console.log(`Deleted Firebase session for ${sanitizedNumber}`);
    } catch (err) {
        console.error(`Failed to delete Firebase session for ${number}:`, err.message || err);
    }
}

async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
            console.log(`🗑️ Deleted local session folder for ${sanitizedNumber}`);
        }

        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`,
            `session/creds_${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
                console.log(`🗑️ Deleted Firebase path: ${p}`);
            } catch (e) {
                console.warn(`⚠️ Firebase delete failed for ${p}:`, e.message);
            }
        }

        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
            console.log(`✅ Removed ${sanitizedNumber} from numbers.json`);
        } catch (e) {
            console.warn(`⚠️ Failed updating numbers.json:`, e.message);
        }

        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {
                console.warn(`⚠️ Socket close error for ${sanitizedNumber}:`, e.message);
            }
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            console.log(`✅ Socket removed for ${sanitizedNumber}`);
        }

    } catch (err) {
        console.error(`❌ Failed to fully delete session for ${sanitizedNumber}:`, err.message);
    }
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);

                await fullDeleteSession(number);

                const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanNumber}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            config.BOT_FOOTER
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error.message || error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Reconnect logic with cooldown protection
                console.log(`Connection lost for ${number}, preparing to reconnect...`);
                
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                // Use scheduleAutoReconnect to avoid rapid restart loops
                scheduleAutoReconnect(number, async () => {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                });
            }        
        }
    });
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;	
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
              
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';

        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const pushname = msg.pushName || 'Name';
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        const supunmdq = { 
            key: { 
                remoteJid: "status@broadcast", 
                fromMe: false, id: 'FAKE_META_ID_001', 
                participant: '13135550002@s.whatsapp.net' 
            }, 
            message: { 
                contactMessage: { 
                    displayName: '@𝚅𝙴𝚂 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃🧑‍💻', 
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Alip;;;;\nFN:Alip\nTEL;waid=13135550002:+1 313 555 0002\nEND:VCARD` 
                } 
            } 
        };

        if (!command) return;

        try {
            switch (command) {
case 'alive': {
    try {
        const date = moment().tz("Asia/Colombo").format("YYYY-MM-DD");
        const time = moment().tz("Asia/Colombo").format("HH:mm:ss");

        await socket.sendMessage(from, {
            react: {
                text: '👋',
                key: m.key
            }
        });

        const ALIVE_MG = `*👋 Hello* ${pushname}

> *👨🏻‍💻 User:* ${pushname}
> *📅 Date:* ${date}
> *⏰ Time:* ${time}

*📂 Type .menu to get all commands.*

> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴠᴇꜱ ᴍɪɴɪ ʙᴏᴛ`;

        await socket.sendMessage(from, {
            image: {
                url: "https://files.catbox.moe/vqt082.jpg"
            },
            caption: ALIVE_MG.trim(),
            contextInfo: {
                mentionedJid: [botJid],
                isForwarded: true,
                forwardingScore: 999,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363399205146445@newsletter",
                    newsletterName: "VES MINI BOT",
                    serverMessageId: 999
                }
            }
        }, {
            quoted: supunmdq
        });

    } catch (err) {
        console.error('❌ Alive Error:', err);

        await socket.sendMessage(from, {
            text: '❌ Failed to send alive message'
        });
    }

    break;
}
case 'menu': {
    try {
        const date = moment().tz("Asia/Colombo").format("YYYY-MM-DD");
        const time = moment().tz("Asia/Colombo").format("HH:mm:ss");

        await socket.sendMessage(from, {
            react: { text: '📜', key: m.key }
        });

        const MENU_TEXT = `*👋 Hello* ${pushname}

🤖 Bot: VES MINI BOT
🖋️ Prefix: [ ${config.PREFIX} ]
⏰ Time: ${time}
📅 Date: ${date}
🟢 Status: Online & Active

*MAIN COMMANDS LIST*

📥 *Download Commands*
  ▫️ .ytmp3 - Download YouTube audio
  ▫️ .ytmp4 - Download YouTube video
  ▫️ .tiktok - Download TikTok video
  ▫️ .fbdl - Download Facebook video
  ▫️ .igdl - Download Instagram video

🤖 *AI & Search Commands*
  ▫️ .ai - Chat with AI assistant
  ▫️ .gpt4 - Ask questions to GPT
  ▫️ .imagine - Generate AI images
  ▫️ .google - Search on Google

👥 *Group Admin Commands*
  ▫️ .tagall - Tag all members
  ▫️ .kick - Remove user
  ▫️ .add - Add user to group
  ▫️ .mute - Mute group chat
  ▫️ .unmute - Unmute group chat

🛠️ *Tools & Converters*
  ▫️ .sticker - Convert to sticker
  ▫️ .toimg - Convert sticker to image
  ▫️ .qr - Generate QR code
  ▫️ .tts - Text to speech audio

👑 *Owner Commands*
  ▫️ .restart - Restart bot process
  ▫️ .block - Block user
  ▫️ .unblock - Unblock user
  ▫️ .getpp - Get user profile picture
  ▫️ .setpp - Set bot profile picture

> ᴘᴏᴡᴇʀᴅ ʙʏ ᴠᴇꜱ ᴍɪɴɪ ʙᴏᴛ`;

        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/vqt082.jpg" },
            caption: MENU_TEXT.trim(),
            contextInfo: {
                mentionedJid: [botJid],
                isForwarded: true,
                forwardingScore: 999,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363399205146445@newsletter",
                    newsletterName: "VES MINI BOT",
                    serverMessageId: 999
                }
            }
        }, { quoted: supunmdq });

    } catch (err) {
        console.error('❌ Menu Error', err);
        await socket.sendMessage(from, { text: '❌ Failed to send menu message' });
    }
    break;
}

// ==========================================
// 🚀 PING COMMAND (.ping)
// ==========================================
case 'ping': {
    try {
        await socket.sendMessage(from, { react: { text: "🚀", key: msg.key } });

        var inital = new Date().getTime();
        const sentMsg = await socket.sendMessage(from, { text: '```Ping!!!```' }, { quoted: msg });
        var final = new Date().getTime();
        
        await socket.sendMessage(from, { text: '*Pong*  *' + (final - inital) + ' ms* ', edit: sentMsg.key });
    } catch (e) {
        console.error("Ping Error:", e);
    }
    break;
}

// ==========================================
// 👑 OWNER CONTACT COMMAND (.owner)
// ==========================================
case 'owner': {
    const ownerNumber = '+94740544995';
    const ownerName = '𝐈𝐒𝐈𝐑𝐀 𝐈𝐍𝐃𝐔𝐖𝐀𝐑𝐀';
    const organization = '*𝚅𝙴𝚂-𝚄𝙻𝚃𝙰* WHATSAPP BOT DEVELOPER 🎭';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact to chat
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Send details message with quoted reference
        await socket.sendMessage(from, {
            text: `*VES-ULTRA-MINI BOT OWNER*\n\n👤 Name: ${ownerName}\n📞 Number: ${ownerNumber}\n\n> © ᴩᴏᴡᴇʀᴅ ʙʏ ᴠᴇꜱ ᴍɪɴɪ ʙᴏᴛ`,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`]
            }
        }, { quoted: sent }); // Quoting the contact message properly

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        }, { quoted: msg });
    }
    break;
}

// ==========================================
// 👁️ VIEW ONCE (VV) RETRIEVE COMMAND
// ==========================================
case 'vv':
case 'viewonce':
case 'retrive': {
    try {
        // Owner Check
        if (!isOwner) {
            return await socket.sendMessage(from, { text: "*📛 This is an owner command.*" }, { quoted: msg });
        }

        // Check if quoted message exists
        if (!quoted || Object.keys(quoted).length === 0) {
            return await socket.sendMessage(from, { text: "*🍁 Please reply to a View Once message!*" }, { quoted: msg });
        }

        // Reaction
        await socket.sendMessage(from, { react: { text: '🐳', key: msg.key } });

        // Extract Quoted Type & Message Body
        let quotedType = Object.keys(quoted)[0];
        let targetMsg = quoted;

        // Ephemeral or View Once Wrapper Unboxing
        if (quotedType === 'viewOnceMessage' || quotedType === 'viewOnceMessageV2') {
            targetMsg = quoted[quotedType].message;
            quotedType = Object.keys(targetMsg)[0];
        }

        // Download Media
        const stream = await downloadContentFromMessage(
            targetMsg[quotedType], 
            quotedType.replace('Message', '')
        );
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const caption = targetMsg[quotedType]?.caption || '';

        // Send Media Back according to type
        if (quotedType === 'imageMessage') {
            await socket.sendMessage(from, { 
                image: buffer, 
                caption: caption 
            }, { quoted: msg });
        } else if (quotedType === 'videoMessage') {
            await socket.sendMessage(from, { 
                video: buffer, 
                caption: caption 
            }, { quoted: msg });
        } else if (quotedType === 'audioMessage') {
            await socket.sendMessage(from, { 
                audio: buffer, 
                mimetype: 'audio/mp4', 
                ptt: targetMsg[quotedType]?.ptt || false 
            }, { quoted: msg });
        } else {
            await socket.sendMessage(from, { text: "❌ Only image, video, and audio viewonce messages are supported." }, { quoted: msg });
        }

    } catch (error) {
        console.error("vv Error:", error);
        await socket.sendMessage(from, { text: "❌ Failed to retrieve viewonce message:\n" + error.message }, { quoted: msg });
    }
    break;
}

// ==========================================
// 👁️ VIEW ONCE TO INBOX (VV2 / EMOJI)
// ==========================================
case 'vv2':
case 'send':
case '❤️':
case '😂':
case '🙂': {
    try {
        if (!isOwner) return; 

        if (!quoted || Object.keys(quoted).length === 0) {
            return await socket.sendMessage(from, { text: "*🍁 Please reply to a View Once message!*" }, { quoted: msg });
        }

        let quotedType = Object.keys(quoted)[0];
        let targetMsg = quoted;

        if (quotedType === 'viewOnceMessage' || quotedType === 'viewOnceMessageV2') {
            targetMsg = quoted[quotedType].message;
            quotedType = Object.keys(targetMsg)[0];
        }

        const stream = await downloadContentFromMessage(
            targetMsg[quotedType], 
            quotedType.replace('Message', '')
        );
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const caption = targetMsg[quotedType]?.caption || '';
        let messageContent = {};

        if (quotedType === 'imageMessage') {
            messageContent = { image: buffer, caption: caption };
        } else if (quotedType === 'videoMessage') {
            messageContent = { video: buffer, caption: caption };
        } else if (quotedType === 'audioMessage') {
            messageContent = { audio: buffer, mimetype: 'audio/mp4', ptt: targetMsg[quotedType]?.ptt || false };
        } else {
            return await socket.sendMessage(from, { text: "❌ Only image, video, and audio viewonce messages are supported." }, { quoted: msg });
        }

        await socket.sendMessage(nowsender, messageContent);

    } catch (error) {
        console.error("vv2 Error:", error);
        await socket.sendMessage(from, { text: "❌ Failed to retrieve viewonce message:\n" + error.message }, { quoted: msg });
    }
    break;
}

// ==========================================
// 🖼️ GET PROFILE PICTURE (.getpp 947xxxxxxxx)
// ==========================================
case 'getpp': {
    try {
        if (!isOwner) return await socket.sendMessage(from, { text: "🚫 *Only owner can use this command!*" }, { quoted: msg });
        if (!args[0]) return await socket.sendMessage(from, { text: "*🔥 Please provide a phone number (e.g., .getpp 94712345678)*" }, { quoted: msg });

        await socket.sendMessage(from, { react: { text: '🖼️', key: msg.key } });

        const targetJid = args[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";
        let ppUrl;
        try {
            ppUrl = await socket.profilePictureUrl(targetJid, "image");
        } catch {
            return await socket.sendMessage(from, { text: "*🖼️ This user has no profile picture or it cannot be accessed!*" }, { quoted: msg });
        }

        await socket.sendMessage(from, { 
            image: { url: ppUrl }, 
            caption: `> *© ᴩᴏᴡᴇʀᴅ ʙʏ ᴠᴇꜱ ᴍɪɴɪ ʙᴏᴛ*` 
        }, { quoted: msg });
    } catch (e) {
        console.error("PP Fetch Error:", e);
        await socket.sendMessage(from, { text: "🛑 An error occurred while fetching the profile picture!" }, { quoted: msg });
    }
    break;
}

// ==========================================
// 🖼️ SET BOT PROFILE PICTURE (.setpp)
// ==========================================
case 'setpp': {
    try {
        if (!isOwner) {
            return await socket.sendMessage(from, { text: '❌ This command is only available for the owner!' }, { quoted: msg });
        }

        if (!quoted || Object.keys(quoted).length === 0) {
            return await socket.sendMessage(from, { text: '⚠️ Please reply to an image with the .setpp command!' }, { quoted: msg });
        }

        let quotedType = Object.keys(quoted)[0];
        let targetMsg = quoted;

        if (quotedType === 'viewOnceMessage' || quotedType === 'viewOnceMessageV2') {
            targetMsg = quoted[quotedType].message;
            quotedType = Object.keys(targetMsg)[0];
        }

        if (quotedType !== 'imageMessage' && quotedType !== 'stickerMessage') {
            return await socket.sendMessage(from, { text: '❌ The replied message must contain an image or sticker!' }, { quoted: msg });
        }

        await socket.sendMessage(from, { react: { text: '🖼️', key: msg.key } });

        const tmpDir = path.join(process.cwd(), 'tmp');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const stream = await downloadContentFromMessage(
            targetMsg[quotedType], 
            quotedType === 'imageMessage' ? 'image' : 'sticker'
        );
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const imagePath = path.join(tmpDir, `profile_${Date.now()}.jpg`);
        fs.writeFileSync(imagePath, buffer);

        await socket.updateProfilePicture(botJid, { url: imagePath });

        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

        await socket.sendMessage(from, { text: '✅ Successfully updated bot profile picture!' }, { quoted: msg });

    } catch (error) {
        console.error('❌ Error in setpp command:', error);
        await socket.sendMessage(from, { text: '❌ Failed to update profile picture!' }, { quoted: msg });
    }
    break;
}

// ==========================================
// 📤 SEND QUOTED MEDIA TO CHAT (.send / .save)
// ==========================================
case 'send':
case 'sendme':
case 'save': {
    try {
        if (!quoted || Object.keys(quoted).length === 0) {
            return await socket.sendMessage(from, { text: "*🍁 Please reply to a message!*" }, { quoted: msg });
        }

        await socket.sendMessage(from, { react: { text: '📤', key: msg.key } });

        let quotedType = Object.keys(quoted)[0];
        let targetMsg = quoted;

        if (quotedType === 'viewOnceMessage' || quotedType === 'viewOnceMessageV2') {
            targetMsg = quoted[quotedType].message;
            quotedType = Object.keys(targetMsg)[0];
        }

        const stream = await downloadContentFromMessage(
            targetMsg[quotedType], 
            quotedType.replace('Message', '')
        );
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const caption = targetMsg[quotedType]?.caption || '';
        let messageContent = {};

        if (quotedType === "imageMessage") {
            messageContent = { image: buffer, caption: caption };
        } else if (quotedType === "videoMessage") {
            messageContent = { video: buffer, caption: caption };
        } else if (quotedType === "audioMessage") {
            messageContent = { audio: buffer, mimetype: 'audio/mp4', ptt: targetMsg[quotedType]?.ptt || false };
        } else {
            return await socket.sendMessage(from, { text: "❌ Only image, video, and audio messages are supported" }, { quoted: msg });
        }

        await socket.sendMessage(from, messageContent, { quoted: msg });
    } catch (error) {
        console.error("Forward Error:", error);
        await socket.sendMessage(from, { text: "❌ Error forwarding message:\n" + error.message }, { quoted: msg });
    }
    break;
}

// ==========================================
// 🆔 GET CHAT/USER JID (.jid)
// ==========================================
case 'jid':
case 'id':
case 'chatid':
case 'gjid': {
    try {
        if (!isOwner) {
            return await socket.sendMessage(from, { text: "❌ *Command Restricted* - Only owner can use this." }, { quoted: msg });
        }

        await socket.sendMessage(from, { react: { text: '🆔', key: msg.key } });

        if (isGroup) {
            return await socket.sendMessage(from, { text: `👥 *Group JID:*\n\`\`\`${from}\`\`\`` }, { quoted: msg });
        } else {
            return await socket.sendMessage(from, { text: `👤 *User JID:*\n\`\`\`${nowsender}\`\`\`` }, { quoted: msg });
        }

    } catch (e) {
        console.error("JID Error:", e);
        await socket.sendMessage(from, { text: `⚠️ Error fetching JID:\n${e.message}` }, { quoted: msg });
    }
    break;
}

// ==========================================
// 🔄 RESTART BOT (.restart)
// ==========================================
case 'restart': {
    try {
        if (!isOwner) return await socket.sendMessage(from, { text: "*⚠️ Only the bot owner can use this command.*" }, { quoted: msg });

        await socket.sendMessage(from, { react: { text: '🔄', key: msg.key } });
        await socket.sendMessage(from, { text: "*🔄 Restarting VES MINI BOT...*" }, { quoted: msg });

        exec(`pm2 restart ${process.env.PM2_NAME || 'VES-MINI-main'}`);
    } catch (e) {
        console.error(e);
        await socket.sendMessage(from, { text: `❌ Restart Error: ${e.message}` }, { quoted: msg });
    }
    break;
}

// ==========================================
// 🚫 BLOCK USER (.block)
// ==========================================
case 'block': {
    try {
        if (!isOwner) {
            await socket.sendMessage(from, { react: { text: '❌', key: msg.key } });
            return await socket.sendMessage(from, { text: "Only the bot owner can use this command." }, { quoted: msg });
        }

        let targetJid;
        if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
            targetJid = msg.message.extendedTextMessage.contextInfo.participant;
        } else if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (args[0] && args[0].includes("@")) {
            targetJid = args[0].replace(/[@\s]/g, '') + "@s.whatsapp.net";
        } else if (args[0] && /^[0-9]+$/.test(args[0])) {
            targetJid = args[0] + "@s.whatsapp.net";
        } else {
            await socket.sendMessage(from, { react: { text: '❌', key: msg.key } });
            return await socket.sendMessage(from, { text: "Please mention a user, reply to their message, or provide a number." }, { quoted: msg });
        }

        await socket.updateBlockStatus(targetJid, "block");
        await socket.sendMessage(from, { react: { text: '✅', key: msg.key } });
        await socket.sendMessage(from, { 
            text: `Successfully blocked @${targetJid.split("@")[0]}`, 
            mentions: [targetJid] 
        }, { quoted: msg });

    } catch (error) {
        console.error("Block command error:", error);
        await socket.sendMessage(from, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(from, { text: "Failed to block the user." }, { quoted: msg });
    }
    break;
}

// pair cmd
         case 'pair': {
    // ✅ Fix for node-fetch v3.x (ESM-only module)
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            text: '*📌 Usage:* .pair +947XXXXXXX'
        }, { quoted: msg });
    }

    try {
        const PAIR_BASE = `https://ves-mini-production.up.railway.app`;
        const url = `${PAIR_BASE}/code?number=${encodeURIComponent(number)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        console.log("🌐 API Response:", bodyText);

        let result;
        try {
            result = JSON.parse(bodyText);
        } catch (e) {
            console.error("❌ JSON Parse Error:", e);
            return await socket.sendMessage(sender, {
                text: '❌ Invalid response from server. Please contact support.'
            }, { quoted: msg });
        }

        if (!result || !result.code) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to retrieve pairing code. Please check the number.'
            }, { quoted: msg });
        }
		await socket.sendMessage(m.chat, { react: { text: '🔑', key: msg.key } });
		
        await socket.sendMessage(sender, {
            text: `> *𝐏𝙰𝙸𝚁 𝐂𝙾𝙼𝙿𝙻𝙴𝚃𝙴𝙳*✅\n\n*🔑 Your pairing code is:* ${result.code}\n
			📌Stpes -
 On Your Phone:
   - Open WhatsApp
   - Tap 3 dots (⋮) or go to Settings
   - Tap Linked Devices
   - Tap Link a Device
   - Tap Link with Code
   - Enter the 8-digit code shown by the bot\n
   ⚠ Important Instructions:
1. ⏳ Pair this code within 1 minute.
2. 🚫 Do not share this code with anyone.
3. 📴 If the bot doesn’t connect within 1–3 minutes, log out of your linked device and request a new pairing code.

> © ᴩᴏᴡᴇʀᴅ ʙʏ ᴠᴇꜱ ᴍɪɴɪ ʙᴏᴛ`
        }, { quoted: msg });

        await sleep(2000);

        await socket.sendMessage(sender, {
            text: `${result.code}`
        }, { quoted: msg });

    } catch (err) {
        console.error("❌ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while processing your request. Please try again later.'
        }, { quoted: msg });
    }

    break;
}
                
                case 'deleteme': {
                    await fullDeleteSession(number);
                    await socket.sendMessage(sender, { text: "✅ Your session has been deleted." });
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    config.BOT_FOOTER
                )
            });
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupAutoRestart(socket, sanitizedNumber);
        handleMessageRevocation(socket, sanitizedNumber);
        setupCommandHandlers(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
            console.log(`Updated creds for ${sanitizedNumber} in Firebase`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                
                const cleanNumber = sanitizedNumber;
                if (pendingAutoReconnect.has(cleanNumber)) {
                   clearTimeout(pendingAutoReconnect.get(cleanNumber));
                   pendingAutoReconnect.delete(cleanNumber);
                }
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            'VEA MINI BOT',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n`,
                            config.BOT_FOOTER
                        )
                    });
                    
                    // Call the admin connection message function
                    // after the WhatsApp bot successfully connects
                   await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    if (numbersRes.data) {
                        numbers = numbersRes.data;
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'VES-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
} // <--- Added missing closing brace here

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '🦠 ves-mini-bot is running',
        activesession: activeSockets.size
    });
});

router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            return {
                number: number,
                status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline',
                uptime: `${hours}h ${minutes}m ${seconds}s`,
                connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
            };
        });

        res.json({
            count: bots.length,
            bots
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get bot info', details: err.message });
    }
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(key =>
            key.startsWith('creds_') && key.endsWith('.json')
        );

        if (sessionKeys.length === 0) {
            return res.status(404).send({ error: 'No session files found in Firebase' });
        }

        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${key}`);
                results.push({ file: key, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    config.BOT_FOOTER
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'VES-MINI-main'}`);
});

async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
               lastAutoReconnectAttempt.set(number.replace(/[^0-9]/g, ''), Date.now());
               const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
               await EmpirePair(number, mockRes);
               console.log(`Reconnected from Firebase: ${number}`);
               await delay(1000);
            }
        }

    } catch (error) {
        console.error('❌ autoReconnectFromFirebase error:', error.message);
    }
}
autoReconnectFromFirebase();

module.exports = router;
