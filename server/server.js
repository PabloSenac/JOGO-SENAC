const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
// Increase maxHttpBufferSize to allow larger base64 images (e.g., 2MB)
const io = socketIo(server, {
    maxHttpBufferSize: 2e6 // 2MB limit for profile pics
});

const PORT = process.env.PORT || 3000;

// --- Game Data Loading ---
let gameData = {};
try {
    // Use path.resolve to ensure correct path from server.js location
    const rawData = fs.readFileSync(path.resolve(__dirname, "../regras.json"));
    gameData = JSON.parse(rawData);
    gameData.habilidadesMap = {};
    gameData.habilidades.forEach(h => gameData.habilidadesMap[h.id] = h.nome);
    console.log("Dados do jogo carregados com sucesso.");
} catch (error) {
    console.error("Erro crítico ao carregar regras.json:", error);
    process.exit(1);
}

// --- Server Setup ---
const clientPath = path.join(__dirname, "../client");
app.use(express.static(clientPath));
app.get("/", (req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

// --- Game State Management ---
let rooms = {}; // { roomId: { id, name, players: {playerId: {id, name, score, trailPosition, team?, profilePic?}}, teams?: {}, gameState: {status, mode: 'team'|'1v1', ...}, chat: [], isPublic, leaderId } }
const MAX_TEAMS = 5;
const MAX_PLAYERS_PER_TEAM = 6;
const MIN_PLAYERS_TEAM = 2; // Min players for team mode
const PLAYERS_1V1 = 2; // Exact players for 1v1 mode

// --- Helper Functions ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getPublicRoomList() {
    const roomList = [];
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.isPublic) {
            roomList.push({
                id: room.id,
                name: room.name,
                playerCount: Object.keys(room.players).length,
                status: room.gameState.status,
                mode: room.gameState.mode || 'team'
            });
        }
    }
    return roomList;
}

function broadcastRoomListUpdate() {
    const socketsInLobby = Array.from(io.sockets.sockets.values()).filter(s => !s.roomId);
    const roomList = getPublicRoomList();
    socketsInLobby.forEach(socket => {
        socket.emit("roomListUpdate", roomList);
    });
}

// Enriched data for TEAM mode (includes player names, not pics for teams)
function getEnrichedTeamsData(room) {
    if (!room || !room.teams || room.gameState.mode !== 'team') return {};
    const enrichedTeams = JSON.parse(JSON.stringify(room.teams));
    Object.values(enrichedTeams).forEach(team => {
        team.allPlayers = {};
        team.players.forEach(playerId => {
            if (room.players[playerId]) {
                // Only include name for team view, not pic
                team.allPlayers[playerId] = { name: room.players[playerId].name };
            }
        });
    });
    return enrichedTeams;
}

// Enriched data for 1v1 mode (includes player pics)
function getEnrichedPlayersData(room) {
    if (!room || !room.players) return {};
    // Return a copy of the players object, including score, trailPosition, and profilePic
    const playersCopy = {};
    for (const playerId in room.players) {
        const player = room.players[playerId];
        playersCopy[playerId] = {
            id: player.id,
            name: player.name,
            score: player.score,
            trailPosition: player.trailPosition,
            profilePic: player.profilePic // Include profile pic
            // Do not include team info here if it exists
        };
    }
    return playersCopy;
}

function assignPlayerToTeam(room, playerId) {
    if (room.gameState.mode !== 'team') return null;
    let assignedTeam = null;
    let smallestTeam = null;
    let minPlayers = MAX_PLAYERS_PER_TEAM + 1;

    for (let i = 1; i <= MAX_TEAMS; i++) {
        const teamId = `team${i}`;
        if (room.teams[teamId] && room.teams[teamId].players.length < MAX_PLAYERS_PER_TEAM && room.teams[teamId].players.length < minPlayers) {
             minPlayers = room.teams[teamId].players.length;
             smallestTeam = teamId;
        }
    }
    if(smallestTeam) {
        assignedTeam = smallestTeam;
    } else {
        for (let i = 1; i <= MAX_TEAMS; i++) {
            const teamId = `team${i}`;
            if (!room.teams[teamId]) {
                room.teams[teamId] = { id: teamId, name: `Time ${i}`, players: [], score: 0, trailPosition: 0 };
                assignedTeam = teamId;
                console.log(`Criado novo time ${teamId} na sala ${room.id}`);
                break;
            }
        }
    }

    if (assignedTeam) {
        room.teams[assignedTeam].players.push(playerId);
        room.players[playerId].team = assignedTeam;
        console.log(`Jogador ${playerId} atribuído ao time ${assignedTeam}`);
    } else {
        console.warn(`Não foi possível atribuir time para ${playerId} na sala ${room.id}`);
        return null;
    }
    return assignedTeam;
}

function removePlayerFromRoom(room, playerId) {
    const player = room.players[playerId];
    if (!player) return;
    if (room.gameState.mode === 'team' && player.team && room.teams[player.team]) {
        const team = room.teams[player.team];
        team.players = team.players.filter(id => id !== playerId);
        console.log(`Jogador ${playerId} removido do time ${player.team}`);
        // Consider deleting team if empty?
    }
    delete room.players[playerId];
    console.log(`Jogador ${playerId} removido da sala ${room.id}`);
}

// --- Game Logic Functions ---
function startGame(roomId, initiatorId) {
    const room = rooms[roomId];
    if (!room || !gameData.situacoes || gameData.situacoes.length === 0) {
        io.to(initiatorId).emit("gameError", "Erro interno ao iniciar o jogo.");
        console.error(`Não é possível iniciar o jogo na sala ${roomId}: dados ausentes.`);
        return;
    }
    if (room.gameState.status !== "waiting") {
        io.to(initiatorId).emit("gameError", "O jogo já foi iniciado ou está finalizado.");
        return;
    }
    if (room.leaderId !== initiatorId) {
         io.to(initiatorId).emit("gameError", "Apenas o líder da sala pode iniciar o jogo.");
         return;
    }

    const activePlayerCount = Object.keys(room.players).length;
    const requiredPlayers = room.gameState.mode === '1v1' ? PLAYERS_1V1 : MIN_PLAYERS_TEAM;
    const playerNoun = room.gameState.mode === '1v1' ? 'jogadores' : 'jogadores (em times)';

    if (activePlayerCount < requiredPlayers) {
        io.to(roomId).emit("gameError", `São necessários ${requiredPlayers} ${playerNoun} para iniciar.`);
        return;
    }
    if (room.gameState.mode === '1v1' && activePlayerCount !== PLAYERS_1V1) {
         io.to(roomId).emit("gameError", `O modo 1v1 requer exatamente ${PLAYERS_1V1} jogadores.`);
         return;
    }

    console.log(`Iniciando jogo ${room.gameState.mode} na sala ${roomId} por ${initiatorId}`);
    room.gameState.status = "started";
    room.isPublic = false;
    broadcastRoomListUpdate();

    Object.values(room.players).forEach(player => {
        player.score = 0;
        player.trailPosition = 0;
    });
    if (room.gameState.mode === 'team') {
        Object.values(room.teams).forEach(team => {
            team.score = 0;
            team.trailPosition = 0;
        });
    }

    room.gameState = {
        ...room.gameState,
        currentRound: 1,
        currentSituationId: null,
        currentSituationText: "",
        playerChoices: {}, // { playerId: skillId }
        roundScores: {}, // { playerId: score }
        roundTimer: null,
        roundEndTime: null,
        availableSkills: gameData.habilidades || [],
        situationsOrder: shuffleArray([...gameData.situacoes].map(s => s.id)),
        skillUsage: {}, // { playerId: { skillId: count } }
        maxRounds: gameData.regras.numeroRodadas || 20,
        roundDurationMs: (gameData.regras.tempoPorRodada || 300) * 1000,
    };

    Object.keys(room.players).forEach(playerId => {
        room.gameState.skillUsage[playerId] = {};
        gameData.habilidades.forEach(h => {
            room.gameState.skillUsage[playerId][h.id] = 0;
        });
    });

    // Send initial game state including player pics
    const initialState = {
        mode: room.gameState.mode,
        players: getEnrichedPlayersData(room), // Always send player data with pics
        teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null
    };

    io.to(roomId).emit("gameStarted", { room: initialState });
    startNewRound(roomId);
}

function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState.status !== "started") return;
    const currentRoundIndex = room.gameState.currentRound - 1;
    if (currentRoundIndex >= room.gameState.situationsOrder.length || room.gameState.currentRound > room.gameState.maxRounds) {
        endGame(roomId);
        return;
    }
    const situationId = room.gameState.situationsOrder[currentRoundIndex];
    const situation = gameData.situacoes.find(s => s.id === situationId);
    if (!situation) {
        console.error(`Situação ${situationId} não encontrada para a rodada ${room.gameState.currentRound} na sala ${roomId}`);
        endGame(roomId);
        return;
    }
    room.gameState.currentSituationId = situationId;
    room.gameState.currentSituationText = situation.texto;
    room.gameState.playerChoices = {};
    room.gameState.roundScores = {};
    room.gameState.roundEndTime = Date.now() + room.gameState.roundDurationMs;
    console.log(`Sala ${roomId}, Rodada ${room.gameState.currentRound}: Situação ${situationId}`);
    if (room.gameState.roundTimer) clearTimeout(room.gameState.roundTimer);
    room.gameState.roundTimer = setTimeout(() => calculateRoundScores(roomId), room.gameState.roundDurationMs);

    const roundData = {
        round: room.gameState.currentRound,
        situationId: room.gameState.currentSituationId,
        situationText: room.gameState.currentSituationText,
        availableSkills: room.gameState.availableSkills,
        endTime: room.gameState.roundEndTime,
        mode: room.gameState.mode,
        players: getEnrichedPlayersData(room), // Send updated player data (with pics)
        teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null
    };

    io.to(roomId).emit("newRound", roundData);
}

function calculateRoundScores(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState.status !== "started" || !room.gameState.currentSituationId) return;
    console.log(`Calculando scores para a rodada ${room.gameState.currentRound} na sala ${roomId}`);
    const situationId = room.gameState.currentSituationId;
    const scoringMatrix = gameData.matrizPontuacao[situationId];
    let roundResults = {}; // { id (player or team): { choice, score, totalScore, advancedTrail } }
    let maxScoreInRound = 0;
    let winnersInRound = []; // List of player or team IDs

    if (!scoringMatrix) {
        console.error(`Matriz de pontuação não encontrada para a situação ${situationId}`);
    } else {
        for (const playerId in room.players) {
            const player = room.players[playerId];
            const chosenSkillId = room.gameState.playerChoices[playerId];
            let score = 0;

            if (chosenSkillId && scoringMatrix[chosenSkillId]) {
                score = scoringMatrix[chosenSkillId];
                if (room.gameState.skillUsage[playerId]) {
                     room.gameState.skillUsage[playerId][chosenSkillId] = (room.gameState.skillUsage[playerId][chosenSkillId] || 0) + 1;
                }
            } else {
                console.log(`Jogador ${playerId} não escolheu ou escolheu habilidade inválida (${chosenSkillId})`);
            }

            room.gameState.roundScores[playerId] = score;
            player.score += score;

            const resultId = room.gameState.mode === 'team' ? player.team : playerId;
            if (!resultId) continue;

            if (room.gameState.mode === 'team') {
                const team = room.teams[resultId];
                if (team) {
                    team.score += score;
                    if (!roundResults[resultId]) {
                        roundResults[resultId] = { choice: null, score: 0, totalScore: team.score, advancedTrail: false };
                    }
                    roundResults[resultId].score += score;
                }
            } else { // 1v1 mode
                roundResults[resultId] = { choice: chosenSkillId, score: score, totalScore: player.score, advancedTrail: false };
            }
        }

        // Determine max score and winners for trail advancement
        if (room.gameState.mode === 'team') {
            Object.values(room.teams).forEach(team => {
                const teamRoundScore = team.players.reduce((sum, pId) => sum + (room.gameState.roundScores[pId] || 0), 0);
                if (teamRoundScore > maxScoreInRound) {
                    maxScoreInRound = teamRoundScore;
                    winnersInRound = [team.id];
                } else if (teamRoundScore === maxScoreInRound && teamRoundScore > 0) {
                    winnersInRound.push(team.id);
                }
            });
        } else { // 1v1 mode
            Object.values(room.players).forEach(player => {
                const playerRoundScore = room.gameState.roundScores[player.id] || 0;
                if (playerRoundScore > maxScoreInRound) {
                    maxScoreInRound = playerRoundScore;
                    winnersInRound = [player.id];
                } else if (playerRoundScore === maxScoreInRound && playerRoundScore > 0) {
                    winnersInRound.push(player.id);
                }
            });
        }
    }

    // Advance trail for winners
    winnersInRound.forEach(winnerId => {
        if (room.gameState.mode === 'team') {
            if(room.teams[winnerId]) {
                room.teams[winnerId].trailPosition += 1;
                if(roundResults[winnerId]) roundResults[winnerId].advancedTrail = true;
            }
        } else { // 1v1 mode
             if(room.players[winnerId]) {
                room.players[winnerId].trailPosition += 1;
                if(roundResults[winnerId]) roundResults[winnerId].advancedTrail = true;
            }
        }
    });

    console.log(`Resultados da Rodada ${room.gameState.currentRound}: ${JSON.stringify(roundResults)}`);

    const roundEndData = {
        round: room.gameState.currentRound,
        results: roundResults,
        mode: room.gameState.mode,
        players: getEnrichedPlayersData(room), // Send updated player data (with pics)
        teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null
    };

    io.to(roomId).emit("roundEnd", roundEndData);

    room.gameState.currentRound++;
    if (room.gameState.currentRound > room.gameState.maxRounds) {
        endGame(roomId);
    } else {
        setTimeout(() => startNewRound(roomId), 7000);
    }
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState.status !== "started") return;
    console.log(`Fim de jogo na sala ${roomId}`);
    room.gameState.status = "finished";
    if (room.gameState.roundTimer) clearTimeout(room.gameState.roundTimer);

    let finalScores = {}; // { id: { name, score, trailPosition, finalScore, profilePic? } }
    let winningScore = -1;
    let winners = []; // List of IDs (player or team)

    // Calculate final score (e.g., score + trailPosition * bonus)
    const calculateFinalScore = (entity) => entity.score + (entity.trailPosition * (gameData.regras.pontosPorAvancoTrilha || 10));

    if (room.gameState.mode === 'team') {
        Object.values(room.teams).forEach(team => {
            if (team.players.length > 0) {
                const finalScore = calculateFinalScore(team);
                finalScores[team.id] = { id: team.id, name: team.name, score: team.score, trailPosition: team.trailPosition, finalScore: finalScore };
                if (finalScore > winningScore) {
                    winningScore = finalScore;
                    winners = [team.id];
                } else if (finalScore === winningScore) {
                    winners.push(team.id);
                }
            }
        });
    } else { // 1v1 mode
        Object.values(room.players).forEach(player => {
            const finalScore = calculateFinalScore(player);
            finalScores[player.id] = { id: player.id, name: player.name, score: player.score, trailPosition: player.trailPosition, finalScore: finalScore, profilePic: player.profilePic }; // Include pic
            if (finalScore > winningScore) {
                winningScore = finalScore;
                winners = [player.id];
            } else if (finalScore === winningScore) {
                winners.push(player.id);
            }
        });
    }

    let message = "Fim de Jogo! ";
    if (winners.length === 1) {
        message += `${finalScores[winners[0]].name} venceu!`;
    } else if (winners.length > 1) {
        message += `Empate entre ${winners.map(id => finalScores[id].name).join(' e ')}!`;
    } else {
        message += "Nenhum vencedor claro.";
    }

    // Aggregate skill usage for teams if in team mode
    let aggregatedSkillUsage = {};
    if (room.gameState.mode === 'team') {
        Object.values(room.teams).forEach(team => {
            aggregatedSkillUsage[team.id] = {};
            gameData.habilidades.forEach(h => {
                aggregatedSkillUsage[team.id][h.id] = 0;
            });
            team.players.forEach(playerId => {
                if (room.gameState.skillUsage[playerId]) {
                    gameData.habilidades.forEach(h => {
                        aggregatedSkillUsage[team.id][h.id] += (room.gameState.skillUsage[playerId][h.id] || 0);
                    });
                }
            });
        });
    } else {
        aggregatedSkillUsage = room.gameState.skillUsage; // Use player usage directly for 1v1
    }

    io.to(roomId).emit("gameOver", {
        message: message,
        finalScores: finalScores,
        winners: winners,
        skillUsage: aggregatedSkillUsage,
        skillNames: gameData.habilidadesMap,
        mode: room.gameState.mode
    });

    // Optionally delete room after a delay or keep it for review?
    // For now, just mark as finished and public again
    room.isPublic = true;
    broadcastRoomListUpdate();
}

// --- Socket.IO Connection Handling ---
io.on("connection", (socket) => {
    console.log(`Novo cliente conectado: ${socket.id}`);
    socket.emit("roomListUpdate", getPublicRoomList());

    socket.on("requestRoomList", () => {
        socket.emit("roomListUpdate", getPublicRoomList());
    });

    socket.on("createRoom", (playerName, roomName, gameMode, profilePicDataUrl) => {
        if (!playerName) return socket.emit("joinError", "Nome do jogador é obrigatório.");
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newRoom = {
            id: roomId,
            name: roomName || `Sala de ${playerName}`,
            players: {},
            teams: {},
            gameState: {
                status: "waiting",
                mode: gameMode || 'team' // Default to team mode
            },
            chat: [],
            isPublic: true,
            leaderId: socket.id,
            minPlayersToStart: gameMode === '1v1' ? PLAYERS_1V1 : MIN_PLAYERS_TEAM
        };
        newRoom.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            trailPosition: 0,
            profilePic: profilePicDataUrl || null // Store profile pic
        };
        socket.roomId = roomId;
        socket.join(roomId);
        rooms[roomId] = newRoom;

        if (newRoom.gameState.mode === 'team') {
            assignPlayerToTeam(newRoom, socket.id);
        }

        console.log(`Sala ${roomId} criada por ${playerName} (ID: ${socket.id}) modo: ${newRoom.gameState.mode}`);
        socket.emit("joinedRoom", {
            ...newRoom,
            players: getEnrichedPlayersData(newRoom), // Send player data with pic
            teams: newRoom.gameState.mode === 'team' ? getEnrichedTeamsData(newRoom) : null
        });
        broadcastRoomListUpdate();
    });

    socket.on("joinRoom", (roomId, playerName, profilePicDataUrl) => {
        if (!playerName) return socket.emit("joinError", "Nome do jogador é obrigatório.");
        const room = rooms[roomId];
        if (!room) {
            return socket.emit("joinError", "Sala não encontrada.");
        }
        if (room.gameState.status !== "waiting") {
            return socket.emit("joinError", "Não é possível entrar em uma sala que já iniciou ou finalizou o jogo.");
        }
        if (room.gameState.mode === '1v1' && Object.keys(room.players).length >= PLAYERS_1V1) {
            return socket.emit("joinError", "Esta sala 1v1 já está cheia.");
        }
        // Add player limit for team mode?

        socket.roomId = roomId;
        socket.join(roomId);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            trailPosition: 0,
            profilePic: profilePicDataUrl || null // Store profile pic
        };

        let assignedTeamId = null;
        if (room.gameState.mode === 'team') {
            assignedTeamId = assignPlayerToTeam(room, socket.id);
            if (!assignedTeamId) {
                // Handle error - maybe room is full?
                delete room.players[socket.id];
                socket.leave(roomId);
                socket.roomId = null;
                return socket.emit("joinError", "Não foi possível entrar no time. A sala pode estar cheia.");
            }
        }

        console.log(`${playerName} (ID: ${socket.id}) entrou na sala ${roomId}`);
        const roomDataToSend = {
            ...room,
            players: getEnrichedPlayersData(room),
            teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null
        };
        socket.emit("joinedRoom", roomDataToSend);
        socket.to(roomId).emit("playerJoined", {
            roomId: roomId,
            playerId: socket.id,
            playerName: playerName,
            players: getEnrichedPlayersData(room),
            teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null,
            mode: room.gameState.mode
        });
        broadcastRoomListUpdate();
    });

    socket.on("startGame", (roomId) => {
        startGame(roomId, socket.id);
    });

    socket.on("chooseSkill", (skillId) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState.status !== "started" || room.gameState.playerChoices[socket.id]) {
            return; // Ignore if game not started, already chosen, or no room
        }
        // Validate skillId?
        if (gameData.habilidadesMap[skillId]) {
            room.gameState.playerChoices[socket.id] = skillId;
            console.log(`Jogador ${socket.id} escolheu habilidade ${skillId} na sala ${roomId}`);
            socket.emit("choiceRegistered", { skillId: skillId });
            // Notify others that this player chose (without revealing the choice)
            socket.to(roomId).emit("playerChoiceUpdate", { playerId: socket.id });

            // Check if all players have chosen
            const activePlayers = Object.keys(room.players);
            const choicesMade = Object.keys(room.gameState.playerChoices).length;
            if (choicesMade === activePlayers.length) {
                console.log(`Todos os jogadores (${choicesMade}/${activePlayers.length}) escolheram na sala ${roomId}. Calculando scores.`);
                if (room.gameState.roundTimer) clearTimeout(room.gameState.roundTimer);
                calculateRoundScores(roomId);
            }
        } else {
            console.warn(`Jogador ${socket.id} tentou escolher habilidade inválida: ${skillId}`);
        }
    });

    socket.on("sendMessage", (message) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || !message || message.length > 500) return; // Basic validation
        const player = room.players[socket.id];
        if (!player) return;

        const chatMessage = {
            roomId: roomId,
            senderId: socket.id,
            sender: player.name,
            text: message,
            teamId: player.team || null,
            timestamp: Date.now()
        };
        room.chat.push(chatMessage);
        // Limit chat history?
        if (room.chat.length > 100) {
            room.chat.shift();
        }
        io.to(roomId).emit("newMessage", chatMessage);
    });

    socket.on("leaveRoom", () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[socket.id];
        const playerName = player ? player.name : `Jogador ${socket.id}`;

        console.log(`${playerName} (ID: ${socket.id}) está saindo da sala ${roomId}`);
        socket.leave(roomId);
        socket.roomId = null;

        removePlayerFromRoom(room, socket.id);

        const remainingPlayers = Object.keys(room.players);
        let newLeaderId = null;
        let newLeaderName = "";

        if (remainingPlayers.length === 0) {
            console.log(`Sala ${roomId} está vazia, removendo.`);
            delete rooms[roomId];
        } else {
            // If leader left, assign a new leader
            if (room.leaderId === socket.id) {
                newLeaderId = remainingPlayers[0]; // Assign first player as new leader
                room.leaderId = newLeaderId;
                newLeaderName = room.players[newLeaderId].name;
                console.log(`${newLeaderName} é o novo líder da sala ${roomId}`);
            }
            // Notify remaining players
            socket.to(roomId).emit("playerLeft", {
                roomId: roomId,
                playerId: socket.id,
                playerName: playerName,
                players: getEnrichedPlayersData(room),
                teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null,
                mode: room.gameState.mode
            });
            if (newLeaderId) {
                io.to(roomId).emit("newLeader", { roomId: roomId, leaderId: newLeaderId, leaderName: newLeaderName });
            }
        }
        broadcastRoomListUpdate();
    });

    socket.on("disconnect", () => {
        console.log(`Cliente desconectado: ${socket.id}`);
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[socket.id];
        const playerName = player ? player.name : `Jogador ${socket.id}`;

        removePlayerFromRoom(room, socket.id);

        const remainingPlayers = Object.keys(room.players);
        let newLeaderId = null;
        let newLeaderName = "";

        if (remainingPlayers.length === 0 && room.gameState.status !== 'finished') {
            console.log(`Sala ${roomId} ficou vazia após desconexão, removendo.`);
            delete rooms[roomId];
        } else if (remainingPlayers.length > 0) {
             // If leader left, assign a new leader
            if (room.leaderId === socket.id) {
                newLeaderId = remainingPlayers[0];
                room.leaderId = newLeaderId;
                newLeaderName = room.players[newLeaderId].name;
                console.log(`${newLeaderName} é o novo líder da sala ${roomId} após desconexão`);
            }
            // Notify remaining players
            socket.to(roomId).emit("playerLeft", {
                roomId: roomId,
                playerId: socket.id,
                playerName: playerName,
                players: getEnrichedPlayersData(room),
                teams: room.gameState.mode === 'team' ? getEnrichedTeamsData(room) : null,
                mode: room.gameState.mode
            });
             if (newLeaderId) {
                io.to(roomId).emit("newLeader", { roomId: roomId, leaderId: newLeaderId, leaderName: newLeaderName });
            }
        }
        broadcastRoomListUpdate();
    });
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

