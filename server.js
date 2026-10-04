/*
 * 8 Américain - jeu de cartes multijoueur et solo
 * Copyright (C) 2026 regis57
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const aiNamesList = [
    'Charles de Gaulle', 'Georges Pompidou', 'Valéry Giscard d\'Estaing', 
    'François Mitterrand', 'Jacques Chirac', 'Nicolas Sarkozy', 
    'François Hollande', 'Emmanuel Macron', 'Vincent Auriol', 'René Coty'
];

function getRandomAINames(count) {
    let shuffled = [...aiNamesList].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

let matchmakingQueue = [];
let matchmakingInterval = null;
let countdownValue = 60;
let activeGames = {}; 

const suits = ['♥', '♦', '♣', '♠'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];

function getCardPoints(value) {
    switch(value) {
        case '8': return 32; case '7': return 14; case 'A': return 11;
        case '10': return 10; case '9': return 9; case 'R': return 4;
        case 'D': return 3; case 'V': return 2; default: return parseInt(value) || 0;
    }
}

function isPlayable(card, activeSuit, topCardValue) {
    if (card.value === '8') return topCardValue !== '8'; 
    return card.suit === activeSuit || card.value === topCardValue;
}

io.on('connection', (socket) => {
    
    socket.on('startSoloGame', (playerName) => {
        const roomId = 'solo_' + socket.id;
        socket.join(roomId);
        let aiNames = getRandomAINames(3);
        let players = [{ id: socket.id, name: playerName, isBot: false, score: 0 }];
        aiNames.forEach((name, idx) => {
            players.push({ id: `bot_${idx}_${socket.id}`, name: name, isBot: true, score: 0 });
        });
        initGame(roomId, players, false);
    });

    socket.on('joinMatchmaking', (playerName) => {
        matchmakingQueue.push({ id: socket.id, name: playerName, score: 0 });
        socket.join('matchmaking_lobby');
        if (matchmakingQueue.length === 1) { countdownValue = 60; startMatchmakingCountdown(); } 
        else { io.to('matchmaking_lobby').emit('matchmakingStatus', { players: matchmakingQueue.map(p => p.name), countdown: countdownValue }); }
        if (matchmakingQueue.length === 4) launchOnlineGameWithBots(0);
    });

    socket.on('forceStartWithBots', () => {
        if (matchmakingQueue.some(p => p.id === socket.id)) launchOnlineGameWithBots(4 - matchmakingQueue.length);
    });

    socket.on('playCard', (data) => {
        const { roomId, cardIndex, chosenSuit } = data;
        let game = activeGames[roomId];
        if (!game || !game.gameActive) return;

        let playerIdx = game.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== game.currentTurn) return; 

        let card = game.players[playerIdx].cards[cardIndex];
        let topCard = game.discardPile[game.discardPile.length - 1];

        if (!isPlayable(card, game.activeSuit, topCard.value)) return;

        game.players[playerIdx].cards.splice(cardIndex, 1);
        game.discardPile.push(card);
        
        game.activeSuit = (card.value === '8' && chosenSuit) ? chosenSuit : card.suit;

        if (game.players[playerIdx].cards.length === 0) {
            game.gameActive = false;
            let matchIsOver = false;
            
            game.players.forEach(p => {
                let pts = 0; p.cards.forEach(c => pts += getCardPoints(c.value)); 
                p.score += pts;
                if(p.score >= 200) matchIsOver = true;
            });

            if (matchIsOver) {
                let winner = game.players.reduce((min, p) => p.score < min.score ? p : min, game.players[0]);
                io.to(roomId).emit('matchEnd', { winner: winner, players: game.players });
            } else {
                io.to(roomId).emit('roundEnd', { players: game.players });
            }
        } else {
            if (card.value === '10') game.playDirection *= -1;
            if (card.value !== '7') game.currentTurn = (game.currentTurn + game.playDirection + 4) % 4;
            broadcastGameState(roomId);
            checkAutoDraw(roomId);
        }
    });

    socket.on('drawCard', (roomId) => handleDraw(roomId, socket.id));

    socket.on('nextRound', (roomId) => {
        let game = activeGames[roomId];
        if (game && !game.gameActive) initGame(roomId, game.players, true);
    });

    socket.on('restartMatch', (roomId) => {
        let game = activeGames[roomId];
        if (game) initGame(roomId, game.players, false);
    });

    socket.on('disconnect', () => {
        matchmakingQueue = matchmakingQueue.filter(p => p.id !== socket.id);
        io.to('matchmaking_lobby').emit('matchmakingStatus', { players: matchmakingQueue.map(p => p.name), countdown: countdownValue });
    });
});

function startMatchmakingCountdown() {
    if (matchmakingInterval) clearInterval(matchmakingInterval);
    matchmakingInterval = setInterval(() => {
        countdownValue--;
        io.to('matchmaking_lobby').emit('matchmakingStatus', { players: matchmakingQueue.map(p => p.name), countdown: countdownValue });
        if (countdownValue <= 0) {
            clearInterval(matchmakingInterval); matchmakingInterval = null;
            launchOnlineGameWithBots(4 - matchmakingQueue.length);
        }
    }, 1000);
}

function launchOnlineGameWithBots(botsCount) {
    if (matchmakingQueue.length === 0) return;
    const roomId = 'online_' + Date.now();
    let finalPlayers = [];
    
    while (matchmakingQueue.length > 0 && finalPlayers.length < 4) {
        let p = matchmakingQueue.shift(); finalPlayers.push({ id: p.id, name: p.name, isBot: false, score: 0 });
    }
    if (botsCount > 0) {
        let aiNames = getRandomAINames(botsCount);
        aiNames.forEach((name, idx) => finalPlayers.push({ id: `bot_${idx}_${roomId}`, name: name, isBot: true, score: 0 }));
    }

    finalPlayers.forEach(p => { if (!p.isBot) { io.sockets.sockets.get(p.id)?.leave('matchmaking_lobby'); io.sockets.sockets.get(p.id)?.join(roomId); } });
    if (matchmakingInterval && matchmakingQueue.length === 0) { clearInterval(matchmakingInterval); matchmakingInterval = null; }
    
    initGame(roomId, finalPlayers, false);
}

function initGame(roomId, playersList, keepScores) {
    let gameDeck = [];
    for (let suit of suits) {
        for (let value of values) gameDeck.push({ suit, value, color: (suit === '♥' || suit === '♦') ? 'red' : 'black' });
    }
    gameDeck = gameDeck.sort(() => Math.random() - 0.5);

    playersList.forEach(p => {
        if (!keepScores) p.score = 0;
        p.cards = [];
        for (let i = 0; i < 6; i++) p.cards.push(gameDeck.pop());
    });

    let firstCard = gameDeck.pop();
    let discard = [firstCard];

    activeGames[roomId] = {
        id: roomId, players: playersList, deck: gameDeck, discardPile: discard,
        currentTurn: 0, playDirection: 1, activeSuit: firstCard.suit, gameActive: true
    };

    io.to(roomId).emit('gameStarted', roomId);
    broadcastGameState(roomId);
    checkAutoDraw(roomId);
}

function handleDraw(roomId, playerId, isAuto = false) {
    let game = activeGames[roomId];
    if (!game || !game.gameActive) return;
    let playerIdx = game.players.findIndex(p => p.id === playerId);
    if (playerIdx !== game.currentTurn) return;

    if (game.deck.length === 0) {
        let top = game.discardPile.pop();
        game.deck = game.discardPile.sort(() => Math.random() - 0.5);
        game.discardPile = [top];
    }
    game.players[playerIdx].cards.push(game.deck.pop());
    game.currentTurn = (game.currentTurn + game.playDirection + 4) % 4;
    broadcastGameState(roomId);
    checkAutoDraw(roomId);
}

function broadcastGameState(roomId) {
    let game = activeGames[roomId];
    if (!game) return;
    game.players.forEach((player, idx) => {
        if (player.isBot) return;
        io.to(player.id).emit('gameState', {
            roomId: roomId, myIndex: idx, playerNames: game.players.map(p => p.name),
            hand: game.players[idx].cards, discardTop: game.discardPile[game.discardPile.length - 1],
            activeSuit: game.activeSuit, currentTurn: game.currentTurn,
            allPlayersCardsCount: game.players.map(p => p.cards.length),
            allPlayersScores: game.players.map(p => p.score)
        });
    });
}

function checkAutoDraw(roomId) {
    let game = activeGames[roomId];
    if (!game || !game.gameActive) return;
    
    let p = game.players[game.currentTurn];
    let topCard = game.discardPile[game.discardPile.length - 1];

    if (p.isBot) {
        setTimeout(() => {
            let playableCards = p.cards.filter(c => isPlayable(c, game.activeSuit, topCard.value));
            if (playableCards.length > 0) {
                let cardToPlay = playableCards[0];
                let chosenSuit = null;
                if(cardToPlay.value === '8') {
                    let suitsInHand = p.cards.map(c => c.suit);
                    chosenSuit = suitsInHand.length ? suitsInHand[0] : suits[Math.floor(Math.random() * suits.length)];
                }
                
                let data = { roomId: roomId, cardIndex: p.cards.indexOf(cardToPlay), chosenSuit: chosenSuit };
                
                p.cards.splice(data.cardIndex, 1);
                game.discardPile.push(cardToPlay);
                game.activeSuit = (cardToPlay.value === '8' && chosenSuit) ? chosenSuit : cardToPlay.suit;

                if (p.cards.length === 0) {
                    game.gameActive = false;
                    let matchIsOver = false;
                    game.players.forEach(pl => {
                        let pts = 0; pl.cards.forEach(c => pts += getCardPoints(c.value)); pl.score += pts;
                        if(pl.score >= 200) matchIsOver = true;
                    });
                    if (matchIsOver) {
                        let winner = game.players.reduce((min, pl) => pl.score < min.score ? pl : min, game.players[0]);
                        io.to(roomId).emit('matchEnd', { winner: winner, players: game.players });
                    } else io.to(roomId).emit('roundEnd', { players: game.players });
                    return;
                }
                if (cardToPlay.value === '10') game.playDirection *= -1;
                if (cardToPlay.value !== '7') game.currentTurn = (game.currentTurn + game.playDirection + 4) % 4;
            } else {
                handleDraw(roomId, p.id, true);
                return;
            }
            broadcastGameState(roomId);
            checkAutoDraw(roomId);
        }, 1500);
    } else {
        let hasPlayable = p.cards.some(c => isPlayable(c, game.activeSuit, topCard.value));
        if (!hasPlayable) {
            io.to(p.id).emit('autoDrawingMsg');
            setTimeout(() => {
                if (game && game.gameActive && game.currentTurn === game.players.indexOf(p)) {
                    handleDraw(roomId, p.id, true);
                }
            }, 2000);
        }
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));