require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const compression = require('compression');
const { LRUCache } = require('lru-cache');

const app = express();
const server = http.createServer(app);
app.use(compression());

// Define allowed origins
const allowedOrigins = [
  // Development URLs
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  
  // Production URLs (without trailing slashes)
  'https://lichess-chess-nexus.lovable.app',
  'https://lovable.dev',
  'https://breakroomchess.com',
  'https://lichessconnector.ey.r.appspot.com'
];

// Socket.io Configuration with updated CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Accept", "Authorization"]
  }
});

// Express Middleware
app.use(express.json());
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    console.log('Request origin:', origin); // Add logging
    
    // Check if the origin or its base path is allowed
    const isAllowed = allowedOrigins.some(allowedOrigin => 
      origin.startsWith(allowedOrigin)
    );
    
    if (!isAllowed) {
      console.log('Blocked origin:', origin);
      return callback(new Error('CORS not allowed'), false);
    }
    
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  credentials: true,
  maxAge: 86400 // Cache preflight requests for 24 hours
}));

// Handle preflight requests
app.options('*', cors());

// At the top of the file, after requiring dependencies
const inMemoryGames = new Map();
let isDbConnected = false;
let serverStarted = false;

// Add this function at the top of your file
const withDbRetry = async (operation, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (!isDbConnected) {
                console.log(`Database not connected, waiting... (attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) throw error;
            console.log(`Operation failed, retrying... (attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
};

// Update the MongoDB connection function
const connectWithRetry = async () => {
    try {
        console.log('Attempting MongoDB connection...');
        
        // Clear any existing connections
        await mongoose.disconnect();
        
        // Set up mongoose options
        mongoose.set('strictQuery', false);
        
        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: 'chess',
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            family: 4,
            authSource: 'admin',
            retryWrites: true,
            w: 'majority'
        });
        
        console.log('Connected to MongoDB');
        isDbConnected = true;
        return true;
    } catch (err) {
        console.error('MongoDB connection error:', err);
        console.error('Connection string:', process.env.MONGODB_URI.replace(/:[^:@]+@/, ':****@'));
        isDbConnected = false;
        return false;
    }
};

// Update the startServer function
const startServer = async () => {
    if (serverStarted) {
        console.log('Server is already running');
        return;
    }

    // Start server immediately
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        serverStarted = true;
    });

    // Try to connect to MongoDB in the background
    try {
        await connectWithRetry();
    } catch (error) {
        console.log('Initial MongoDB connection failed, will retry in background');
    }

    // Keep trying to connect in the background
    setInterval(async () => {
        if (!isDbConnected) {
            try {
                await connectWithRetry();
            } catch (error) {
                console.log('MongoDB connection retry failed');
            }
        }
    }, 30000);
};

// Simplify the Chess Game Schema to store only essential info
const chessGameSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now }
});

const ChessGame = mongoose.model('ChessGame', chessGameSchema);

const LICHESS_API_BASE = 'https://lichess.org/api';

console.log('LICHESS_TOKEN:', process.env.LICHESS_TOKEN); // Check if token is loaded

if (!process.env.LICHESS_TOKEN) {
    console.error('LICHESS_TOKEN is not set in environment variables');
    process.exit(1);
}

// Start the server
startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});

// Update the cache initialization
const gameStatusCache = new LRUCache({
  max: 500, // Store up to 500 game statuses
  ttl: 1000 * 60 * 5 // Items expire after 5 minutes
});

// Simplified endpoint to fetch game data
app.get('/api/chess/game/:gameId', async (req, res) => {
    try {
        const { gameId } = req.params;

        // Try to fetch as a public game first
        try {
            const response = await axios.get(
                `https://lichess.org/game/export/${gameId}`,
                {
                    params: {
                        moves: true,
                        pgnInJson: true,
                        clocks: true,
                        evals: true,
                        opening: true
                    },
                    headers: {
                        'Accept': 'application/json'
                    }
                }
            );

            res.json({
                success: true,
                game: {
                    id: gameId,
                    status: response.data.status,
                    players: response.data.players,
                    moves: response.data.moves,
                    pgn: response.data.pgn,
                    clock: response.data.clock,
                    winner: response.data.winner,
                    opening: response.data.opening,
                    fen: response.data.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
                }
            });
        } catch (publicError) {
            // If public fetch fails, try as a private game
            const response = await axios.get(
                `https://lichess.org/api/board/game/${gameId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
                        'Accept': 'application/json'
                    }
                }
            );

            res.json({
                success: true,
                game: {
                    id: gameId,
                    status: response.data.status,
                    moves: response.data.state?.moves,
                    fen: response.data.state?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                    clock: {
                        white: response.data.state?.wtime,
                        black: response.data.state?.btime
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error fetching game:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch game',
            details: error.response?.data || error.message
        });
    }
});

// Update the create game endpoint
app.post('/api/chess/create-game', async (req, res) => {
  try {
    console.log('Received create game request');
    
    const defaultTimeControl = {
      time: 600,
      increment: 5
    };

    console.log('Creating Lichess challenge...');
    const response = await axios.post(
      'https://lichess.org/api/challenge/open',
      {
        rated: false,
        clock: {
          limit: defaultTimeControl.time,
          increment: defaultTimeControl.increment
        },
        variant: 'standard',
        color: 'random'
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Lichess response:', response.data);

    // Generate unique tokens
    const whiteToken = uuidv4();
    const blackToken = uuidv4();

    // Save game
    inMemoryGames.set(response.data.id, {
      id: response.data.id,
      whiteToken,
      blackToken,
      whiteConnected: false,
      blackConnected: false,
      status: 'waiting',
      createdAt: new Date()
    });

    const result = {
      success: true,
      gameId: response.data.id,
      whiteUrl: `${process.env.FRONTEND_URL}/game/${response.data.id}/white?token=${whiteToken}`,
      blackUrl: `${process.env.FRONTEND_URL}/game/${response.data.id}/black?token=${blackToken}`,
      spectatorUrl: `${process.env.FRONTEND_URL}/game/${response.data.id}`
    };

    console.log('Sending response:', result);
    res.json(result);

  } catch (error) {
    console.error('Error creating game:', error);
    console.error('Error details:', error.response?.data);
    res.status(500).json({
      success: false,
      error: 'Failed to create game',
      details: error.response?.data || error.message
    });
  }
});

app.get('/api/chess/game/:gameId/validate-token', (req, res) => {
  try {
    const { gameId } = req.params;
    const { token, color } = req.query;

    const game = inMemoryGames.get(gameId);
    if (!game) {
      return res.status(404).json({ valid: false, error: 'Game not found' });
    }

    const isValid = color === 'white' 
      ? token === game.whiteToken
      : token === game.blackToken;

    res.json({ valid: isValid });
  } catch (error) {
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});


app.post('/api/chess/accept-seek/:seekId', async (req, res) => {
  try {
    const { seekId } = req.params;
    
    const response = await axios.post(
      `https://lichess.org/api/board/seek/${seekId}/accept`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      gameId: response.data.gameId,
      url: `https://lichess.org/${response.data.gameId}`
    });
  } catch (error) {
    console.error('Error accepting seek:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to accept seek',
      details: error.response?.data || error.message
    });
  }
});

// Update the games endpoint
app.get('/api/chess/games', async (req, res) => {
    try {
        let games = [];
        if (isDbConnected) {
            games = await ChessGame.find()
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();

            // Transform the games data
            games = games.map(game => ({
                id: game.id,
                status: game.status || 'created',
                createdAt: game.createdAt,
                url: `https://lichess.org/${game.id}`,
                whiteUrl: `https://lichess.org/${game.id}/white`,
                blackUrl: `https://lichess.org/${game.id}/black`,
                variant: game.variant,
                timeControl: game.timeControl
            }));
        }

        console.log('Fetched games:', games);

        res.json({
            success: true,
            games: games
        });
    } catch (error) {
        console.error('Error fetching games:', error);
        res.status(500).json({
            success: false,
            games: [],
            error: 'Failed to fetch games'
        });
    }
});

// Stream game moves
app.get('/api/chess/game/:gameId/stream', async (req, res) => {
    try {
        const { gameId } = req.params;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const response = await axios.get(
            `https://lichess.org/api/board/game/stream/${gameId}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
                    'Accept': 'application/x-ndjson'
                },
                responseType: 'stream'
            }
        );

        response.data.on('data', chunk => {
            try {
                const data = JSON.parse(chunk.toString());
                res.write(`data: ${JSON.stringify({
                    type: 'gameState',
                    ...data
                })}\n\n`);
            } catch (e) {
                console.error('Error parsing stream data:', e);
            }
        });

        req.on('close', () => {
            response.data.destroy();
        });
    } catch (error) {
        console.error('Error streaming game:', error.response?.data || error.message);
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream failed' })}\n\n`);
        res.end();
    }
});

// Create AI game
app.post('/api/chess/create-ai-game', async (req, res) => {
  try {
    const { playerId, color, level, timeControl = '10+5' } = req.body;
    console.log('Creating AI game with params:', { playerId, color, level, timeControl });

    const player = await User.findById(playerId);
    if (!player) {
      console.error('Player not found:', playerId);
      return res.status(404).json({ error: "Player not found" });
    }

    // Create AI challenge on Lichess
    const lichessResponse = await axios.post(
      'https://lichess.org/api/challenge/ai',
      {
        level,
        color,
        clock: {
          limit: parseInt(timeControl.split('+')[0]) * 60,
          increment: parseInt(timeControl.split('+')[1])
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Lichess response:', lichessResponse.data);

    // Create or get AI player
    const aiPlayer = await User.findOneAndUpdate(
      { email: 'ai@chess.com' },
      { 
        email: 'ai@chess.com',
        name: 'AI Player',
        password: 'aipassword',
        type: 'client'
      },
      { upsert: true, new: true }
    );

    const newGame = new ChessGame({
      id: lichessResponse.data.id,
      url: lichessResponse.data.url,
      status: 'created',
      whitePlayer: color === 'white' ? player._id : aiPlayer._id,
      blackPlayer: color === 'black' ? player._id : aiPlayer._id,
      timeControl: {
        show: timeControl
      }
      // ... other game properties
    });

    await newGame.save();
    console.log('New game saved:', newGame);

    // Populate the game with player information
    const populatedGame = await ChessGame.findById(newGame._id)
      .populate('whitePlayer', 'name email')
      .populate('blackPlayer', 'name email')
      .lean();

    console.log('Populated game:', populatedGame);

    res.json({
      success: true,
      game: populatedGame
    });

  } catch (error) {
    console.error("AI game creation error:", error);
    res.status(500).json({ 
      error: "Failed to create AI game",
      details: error.message
    });
  }
});

// Simplified game state tracking
const activeGames = new Map();

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  socket.on("joinGame", async ({ gameId, color, token }) => {
    try {
      const game = inMemoryGames.get(gameId);
      if (!game) {
        throw new Error("Game not found");
      }

      // Validate token
      const isValidToken = color === 'white'
        ? token === game.whiteToken
        : token === game.blackToken;

      if (!isValidToken) {
        throw new Error("Invalid player token");
      }

      // Join the game room
      socket.join(`game-${gameId}`);
      
      // Mark player as connected
      if (color === 'white') {
        game.whiteConnected = true;
        game.whiteSocket = socket.id;
      } else {
        game.blackConnected = true;
        game.blackSocket = socket.id;
      }

      // Update game status
      inMemoryGames.set(gameId, game);

      // Notify player about successful join
      socket.emit('playerJoined', { 
        color,
        gameId,
        status: game.status
      });

      // Check if both players are connected
      if (game.whiteConnected && game.blackConnected) {
        game.status = 'started';
        inMemoryGames.set(gameId, game);

        // Notify both players that game is starting
        io.to(`game-${gameId}`).emit('gameStarted', {
          status: 'started',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          white: game.whiteSocket,
          black: game.blackSocket
        });
      } else {
        // Notify player that we're waiting for opponent
        const waitingMessage = `Waiting for ${color === 'white' ? 'black' : 'white'} player`;
        socket.emit('waitingForOpponent', { 
          color, 
          status: 'waiting',
          message: waitingMessage
        });
      }
    } catch (error) {
      console.error('Error in joinGame:', error);
      socket.emit('error', { message: error.message });
    }
  });
  // Handle moves
  socket.on("makeMove", async ({ gameId, move }) => {
    try {
      const gameState = activeGames.get(gameId);
      if (!gameState) throw new Error("Game not found");
      
      // Broadcast move to opponent
      const opponentId = gameState.white === socket.id ? gameState.black : gameState.white;
      if (opponentId) {
        io.to(opponentId).emit('moveMade', move);
      }
    } catch (error) {
      console.error('Error making move:', error);
      socket.emit('moveError', { message: 'Invalid move' });
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Notify opponents about disconnection
    for (const [gameId, game] of activeGames.entries()) {
      if (game.white === socket.id || game.black === socket.id) {
        const opponentId = game.white === socket.id ? game.black : game.white;
        if (opponentId) {
          io.to(opponentId).emit('opponentDisconnected');
        }
      }
    }
  });
});

function validateMove(req, res, next) {
    const { gameId, move } = req.body;
    
    try {
        const game = getGame(gameId);
        if (!game) throw new Error("Game not found");
        
        const chess = new Chess(game.fen);
        const possibleMoves = chess.moves({ square: move.from, verbose: true });
        
        const isValid = possibleMoves.some(m => 
            m.to === move.to && 
            (!move.promotion || m.promotion === move.promotion)
        );
        
        if (!isValid) throw new Error("Invalid move");
        
        req.game = game;
        req.chess = chess;
        next();
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

// Game Status Updater
const updateGameStatus = async (gameId) => {
    try {
        const game = await ChessGame.findById(gameId);
        if (!game || game.status === 'finished') return;

        const gameData = await fetchLichessGameWithRetry(game.id);

        if (gameData.status !== game.status) {
            const updatedGame = await ChessGame.findByIdAndUpdate(
                gameId,
                { 
                    status: gameData.status,
                    cachedPgn: gameData.moves,
                    cachedStatus: gameData.status,
                    lastSyncAt: new Date()
                },
                { new: true }
            );

            io.to(`game-${gameId}`).emit('gameStatusUpdate', {
                gameId,
                status: gameData.status,
                gameData
            });

            if (gameData.status === 'finished') {
                io.to(game.whitePlayer.toString()).emit('gameFinished', updatedGame);
                io.to(game.blackPlayer.toString()).emit('gameFinished', updatedGame);
            }
        }
    } catch (error) {
        console.error(`Error updating game ${gameId}:`, error);
    }
};

// Join a game before accessing it
app.post('/api/chess/game/:gameId/join', async (req, res) => {
    try {
        const { gameId } = req.params;
        const { color } = req.body;

        // Join the game on Lichess
        await axios.post(
            `https://lichess.org/api/board/game/${gameId}/join/${color}`,
            {},
            {
                headers: {
                    'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            message: `Joined game as ${color}`
        });
    } catch (error) {
        console.error('Error joining game:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to join game',
            details: error.response?.data || error.message
        });
    }
});

// Add a move endpoint
app.post('/api/chess/game/:gameId/move', async (req, res) => {
    try {
        const { gameId } = req.params;
        const { move } = req.body;

        // Make move on Lichess
        const response = await axios.post(
            `https://lichess.org/api/board/game/${gameId}/move/${move.from}${move.to}${move.promotion || ''}`,
            {},
            {
                headers: {
                    'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            move: response.data
        });
    } catch (error) {
        console.error('Error making move:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to make move',
            details: error.response?.data || error.message
        });
    }
});

// Update the public game endpoint
app.get('/api/chess/game/export/:gameId', async (req, res) => {
    try {
        const { gameId } = req.params;
        
        // Validate gameId
        if (!gameId || typeof gameId !== 'string') {
            throw new Error('Invalid game ID');
        }
        
        console.log(`Exporting game ${gameId} from Lichess`);

        const response = await axios.get(
            `https://lichess.org/game/export/${gameId}`,
            {
                params: {
                    moves: true,
                    pgnInJson: true,
                    clocks: true,
                    evals: true,
                    opening: true
                },
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${process.env.LICHESS_TOKEN}`
                }
            }
        );

        res.json({
            success: true,
            game: {
                id: gameId,
                ...response.data
            }
        });
    } catch (error) {
        console.error("Error exporting game:", error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: "Failed to export game",
            details: error.message
        });
    }
});

// Add a health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Add a test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working' });
});