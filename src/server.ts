import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Data file paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
const MOMENTS_FILE = path.join(DATA_DIR, 'moments.json');
const MOODS_FILE = path.join(DATA_DIR, 'moods.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const QUIZ_FILE = path.join(DATA_DIR, 'quiz.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load existing data or create empty arrays
const loadData = <T>(filePath: string): T[] => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err);
  }
  return [];
};

const saveData = <T>(filePath: string, data: T[]): void => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error saving ${filePath}:`, err);
  }
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true, // Dynamically match requester
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());

// Store active users and their socket IDs
const activeUsers = new Map<string, string>();

// Message type
interface Message {
  id: string;
  from: string;
  to: string;
  message: string;
  timestamp: Date;
}

// Journal entry type
interface JournalEntry {
  id: string;
  from: string;
  content: string;
  date: Date;
  mood: string;
}

// Moments type
interface Moment {
  id: string;
  url: string;
  caption: string;
  date: string;
  from: string;
  type: 'photo' | 'milestone';
}

// Mood type
interface MoodStatus {
  from: string;
  mood: string;
  energy: number;
  updatedAt: Date;
}

// Call stats data
interface CallStats {
  [userId: string]: number;
}

// Quiz answer type
interface QuizAnswer {
  id: string;
  from: string;
  questionId: string;
  answerId: string;
  correct: boolean;
  timestamp: Date;
}

// Load persisted data
const messages: Message[] = loadData<Message>(MESSAGES_FILE);
const journalEntries: JournalEntry[] = loadData<JournalEntry>(JOURNAL_FILE);
const moments: Moment[] = loadData<Moment>(MOMENTS_FILE);
const moods: MoodStatus[] = loadData<MoodStatus>(MOODS_FILE);
const callStats: CallStats = loadData<CallStats>(STATS_FILE)[0] || {};
const quizAnswers: QuizAnswer[] = loadData<QuizAnswer>(QUIZ_FILE);

const getUserIdBySocket = (socketId: string) => {
  for (const [userId, id] of activeUsers.entries()) {
    if (id === socketId) return userId;
  }
  return '';
};

const getLastActivity = (userId: string) => {
  const messageDates = messages
    .filter(m => m.from === userId || m.to === userId)
    .map(m => new Date(m.timestamp).getTime());
  const journalDates = journalEntries.map(e => new Date(e.date).getTime());
  const momentDates = moments.map(m => new Date(m.date).getTime());

  const all = [...messageDates, ...journalDates, ...momentDates].filter(Boolean);
  if (all.length === 0) return null;
  return new Date(Math.max(...all));
};

const buildStatsForUser = (userId: string) => {
  const messagesCount = messages.filter(m => m.from === userId || m.to === userId).length;
  const journalsCount = journalEntries.length;
  const momentsCount = moments.length;
  const callsCount = callStats[userId] || 0;
  const lastActivity = getLastActivity(userId);

  return {
    userId,
    messages: messagesCount,
    journals: journalsCount,
    moments: momentsCount,
    calls: callsCount,
    lastActivity: lastActivity ? lastActivity.toISOString() : null,
  };
};

const emitStatsToActiveUsers = (userIds: string[]) => {
  userIds.forEach((userId) => {
    const socketId = activeUsers.get(userId);
    if (socketId) {
      io.to(socketId).emit('stats:update', buildStatsForUser(userId));
    }
  });
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`[Socket] New connection attempt: ${socket.id} from ${socket.handshake.address}`);

  // User joins with their user ID
  socket.on('user:join', (userId: string) => {
    activeUsers.set(userId, socket.id);
    console.log(`[UserJoin] ${userId} attached to socket ${socket.id}`);

    const onlineUsers = Array.from(activeUsers.keys());
    console.log(`[Status] Online users: ${onlineUsers.join(', ')}`);

    socket.emit('user:list', onlineUsers);

    // Send chat history to user (messages involving them)
    const userMessages = messages.filter(m => m.from === userId || m.to === userId);
    socket.emit('messages:sync', userMessages);

    // Send existing journal entries to user upon join
    socket.emit('journal:sync', journalEntries);

    // Send existing moments to user upon join
    socket.emit('moments:sync', moments);

    // Send mood statuses to user upon join
    socket.emit('mood:sync', moods);

    // Send quiz sync (recent answers)
    socket.emit('quiz:sync', quizAnswers);

    // Send stats snapshot
    socket.emit('stats:sync', buildStatsForUser(userId));

    socket.broadcast.emit('user:online', userId);
  });

  // Journal Events
  socket.on('journal:add', (entry) => {
    const newEntry = { ...entry, id: Date.now().toString(), date: new Date() };
    journalEntries.push(newEntry);
    saveData(JOURNAL_FILE, journalEntries);
    io.emit('journal:new', newEntry); // Broadcast to all

    // Update stats for all online users
    emitStatsToActiveUsers(Array.from(activeUsers.keys()));
  });

  // Moments Events
  socket.on('moments:add', (moment: Moment) => {
    const newMoment: Moment = {
      ...moment,
      id: Date.now().toString(),
    };
    moments.push(newMoment);
    saveData(MOMENTS_FILE, moments);
    io.emit('moments:new', newMoment);

    emitStatsToActiveUsers(Array.from(activeUsers.keys()));
  });

  // Mood Events
  socket.on('mood:update', (mood: { from: string; mood: string; energy: number }) => {
    const existingIndex = moods.findIndex(m => m.from === mood.from);
    const newMood: MoodStatus = {
      from: mood.from,
      mood: mood.mood,
      energy: mood.energy,
      updatedAt: new Date(),
    };

    if (existingIndex >= 0) {
      moods[existingIndex] = newMood;
    } else {
      moods.push(newMood);
    }

    saveData(MOODS_FILE, moods);
    io.emit('mood:new', newMood);
  });

  // Quiz Events
  socket.on('quiz:submit', (payload: { from: string; questionId: string; answerId: string }) => {
    const correctAnswer = payload.questionId === 'q1' ? 'b' : '';
    const isCorrect = payload.answerId === correctAnswer;

    const newAnswer: QuizAnswer = {
      id: Date.now().toString(),
      from: payload.from,
      questionId: payload.questionId,
      answerId: payload.answerId,
      correct: isCorrect,
      timestamp: new Date(),
    };

    quizAnswers.push(newAnswer);
    saveData(QUIZ_FILE, quizAnswers);

    socket.emit('quiz:result', {
      unlocked: isCorrect,
      message: isCorrect ? 'Unlocked! 💖' : 'Try again tomorrow 💫',
    });
  });

  // Handle chat messages
  socket.on('message:send', (data: { to: string; message: string; from: string }) => {
    const recipientSocketId = activeUsers.get(data.to);
    console.log(`[Message] ${data.from} -> ${data.to} (Socket: ${recipientSocketId || 'OFFLINE'})`);

    // Create message object
    const newMessage: Message = {
      id: Date.now().toString(),
      from: data.from,
      to: data.to,
      message: data.message,
      timestamp: new Date(),
    };

    // Store message
    messages.push(newMessage);
    saveData(MESSAGES_FILE, messages);

    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message:receive', {
        from: data.from,
        message: data.message,
        timestamp: newMessage.timestamp,
      });
    }

    emitStatsToActiveUsers([data.from, data.to]);
  });

  // Handle typing indicator
  socket.on('typing:start', (data: { to: string; from: string }) => {
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing:show', data.from);
    }
  });

  socket.on('typing:stop', (data: { to: string; from: string }) => {
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('typing:hide', data.from);
    }
  });

  // WebRTC Signaling for Video/Audio Calls
  socket.on('call:initiate', (data: { to: string; from: string; signal: any; isVideo: boolean }) => {
    const recipientSocketId = activeUsers.get(data.to);
    console.log(`[Call] Initiate from ${data.from} to ${data.to} (Video: ${data.isVideo})`);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call:incoming', {
        from: data.from,
        signal: data.signal,
        isVideo: data.isVideo,
      });
    }
  });

  socket.on('call:accept', (data: { to: string; signal: any }) => {
    const recipientSocketId = activeUsers.get(data.to);
    console.log(`[Call] Accept from socket to ${data.to}, found socket: ${!!recipientSocketId}`);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call:accepted', {
        signal: data.signal,
      });
      console.log(`[Call] Sent call:accepted to ${data.to}`);
    }

    const fromUser = getUserIdBySocket(socket.id);
    if (fromUser) {
      callStats[fromUser] = (callStats[fromUser] || 0) + 1;
    }
    callStats[data.to] = (callStats[data.to] || 0) + 1;
    saveData(STATS_FILE, [callStats]);
    emitStatsToActiveUsers([fromUser, data.to].filter(Boolean));
  });

  socket.on('call:reject', (data: { to: string }) => {
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call:rejected');
    }
  });

  socket.on('call:end', (data: { to: string }) => {
    const recipientSocketId = activeUsers.get(data.to);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call:ended');
    }
  });

  // ICE candidate relay for WebRTC
  socket.on('call:signal', (data: { to: string; signal: any }) => {
    const recipientSocketId = activeUsers.get(data.to);
    // Find who sent this
    let fromUser = '';
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        fromUser = userId;
        break;
      }
    }
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call:signal', {
        from: fromUser,
        signal: data.signal,
      });
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Find and remove user from active users
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);
        socket.broadcast.emit('user:offline', userId);
        break;
      }
    }
  });
});

// Basic health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ status: 'ok', message: 'Valentine Moments API is running 💕' });
});

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💕 Valentine Moments API ready!`);
});
