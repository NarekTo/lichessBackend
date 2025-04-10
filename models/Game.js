const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  lichessId: {
    type: String,
    required: true,
    unique: true
  },
  player1: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  player2: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  timeControl: {
    type: String,
    default: '10+0'
  },
  status: {
    type: String,
    enum: ['waiting', 'active', 'finished', 'aborted'],
    default: 'waiting'
  },
  result: {
    type: String,
    enum: ['1-0', '0-1', '1/2-1/2', null],
    default: null
  },
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  moves: [{
    move: String,
    fen: String,
    clock: Number,
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  startedAt: Date,
  finishedAt: Date
}, {
  timestamps: true
});

// Indexes for better query performance
gameSchema.index({ player1: 1, status: 1 });
gameSchema.index({ player2: 1, status: 1 });
gameSchema.index({ lichessId: 1 }, { unique: true });
gameSchema.index({ createdAt: -1 });
gameSchema.index({ status: 1 });
gameSchema.index({ whitePlayer: 1, blackPlayer: 1 });

module.exports = mongoose.model('Game', gameSchema);