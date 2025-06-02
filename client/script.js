const socket = io();

// --- UI Elements ---
// Lobby
const lobbyArea = document.getElementById("lobby-area");
const playerNameInput = document.getElementById("player-name");
const profilePicUploadInput = document.getElementById("profile-pic-upload");
const profilePicPreviewImg = document.getElementById("profile-pic-preview");
const lobbyErrorP = document.getElementById("lobby-error");
const newRoomNameInput = document.getElementById("new-room-name");
const gameModeSelect = document.getElementById("game-mode-select");
const createRoomButton = document.getElementById("create-room-button");
const roomListUl = document.getElementById("room-list");

// Waiting Room
const waitingRoomArea = document.getElementById("waiting-room-area");
const waitingRoomTitle = document.getElementById("waiting-room-title");
const waitingRoomModeP = document.getElementById("waiting-room-mode");
const waitingPlayerCountSpan = document.getElementById("waiting-player-count");
const waitingPlayersUl = document.getElementById("waiting-players");
const waitingMessageP = document.getElementById("waiting-message");
const startGameButton = document.getElementById("start-game-button");
const leaveRoomButton = document.getElementById("leave-room-button");
const waitingErrorP = document.getElementById("waiting-error");
const waitingChatArea = document.getElementById("waiting-chat-area");
const waitingChatMessagesDiv = document.getElementById("waiting-chat-messages");
const waitingChatInput = document.getElementById("waiting-chat-input");
const waitingSendChatButton = document.getElementById("waiting-send-chat-button");

// Game Area
const gameArea = document.getElementById("game-area");
const gameModeDisplaySpan = document.getElementById("game-mode-display");
const currentRoomIdSpan = document.getElementById("current-room-id");
const currentRoundSpan = document.getElementById("current-round");
const maxRoundsSpan = document.getElementById("max-rounds");
const situationArea = document.getElementById("situation-area");
const situationTextP = document.getElementById("situation-text");
const timerSpan = document.getElementById("timer");
const roulettePlaceholder = document.getElementById("roulette-placeholder");
const skillsArea = document.getElementById("skills-area");
const skillCardsDiv = document.getElementById("skill-cards");
const scoreboardArea = document.getElementById("scoreboard-area");
const visualTrailDiv = document.getElementById("visual-trail");
const scoreboardListUl = document.getElementById("scoreboard-list");
const chatArea = document.getElementById("chat-area");
const chatMessagesDiv = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendChatButton = document.getElementById("send-chat-button");

// Results Area
const resultsArea = document.getElementById("results-area");
const gameOverMessageP = document.getElementById("game-over-message");
const finalScoresDiv = document.getElementById("final-scores");
const personalityChartCanvas = document.getElementById("personality-chart");
const backToLobbyButton = document.getElementById("back-to-lobby-button");

// --- Game State Variables ---
let currentView = "lobby"; // lobby, waiting, game
let currentRoom = null; // Stores full room object when joined
let currentPlayerId = null;
let currentPlayerName = "";
let playerProfilePicDataUrl = null; // Store Base64 image data
let isLeader = false;
let roundInterval = null;
let personalityChart = null;
let gameDataCache = {}; // To store skill names etc.
let rouletteTimeout = null;
let trailInitialized = false;
const MAX_TRAIL_STEPS = 20;
const MAX_IMAGE_SIZE_MB = 1; // Max image size in MB
const DEFAULT_PROFILE_PIC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23eee'/%3E%3Ctext x='50' y='55' font-family='Arial' font-size='40' fill='%23aaa' text-anchor='middle'%3E?%3C/text%3E%3C/svg%3E";

// --- Helper Functions ---
function switchView(view) {
    lobbyArea.classList.add("hidden");
    waitingRoomArea.classList.add("hidden");
    gameArea.classList.add("hidden");
    resultsArea.classList.add("hidden");

    currentView = view;
    if (view === "lobby") {
        lobbyArea.classList.remove("hidden");
        socket.emit("requestRoomList");
        trailInitialized = false;
        // Reset profile pic if needed, or keep it?
        // profilePicPreviewImg.src = DEFAULT_PROFILE_PIC;
        // playerProfilePicDataUrl = null;
    } else if (view === "waiting") {
        waitingRoomArea.classList.remove("hidden");
    } else if (view === "game") {
        gameArea.classList.remove("hidden");
        resultsArea.classList.add("hidden");
        skillsArea.classList.remove("hidden");
        situationArea.classList.remove("hidden");
        if (!trailInitialized) {
            initializeVisualTrail();
            trailInitialized = true;
        }
    }
    console.log(`Switched view to: ${view}`);
}

function showError(element, message) {
    element.textContent = message;
    element.classList.remove("hidden");
    setTimeout(() => { element.classList.add("hidden"); }, 5000);
}

function formatTime(ms) {
    if (ms <= 0) return "00:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function startTimer(endTime) {
    if (roundInterval) clearInterval(roundInterval);
    timerSpan.classList.remove("ending");
    const updateTimer = () => {
        const now = Date.now();
        const timeLeft = endTime - now;
        if (timeLeft <= 0) {
            timerSpan.textContent = "00:00";
            clearInterval(roundInterval);
            disableSkillCards("Tempo esgotado!");
        } else {
            timerSpan.textContent = formatTime(timeLeft);
            if (timeLeft < 10000 && !timerSpan.classList.contains("ending")) {
                // timerSpan.classList.add("ending");
            }
        }
    };
    updateTimer();
    roundInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    if (roundInterval) clearInterval(roundInterval);
    timerSpan.textContent = "--:--";
}

// --- UI Update Functions ---
function updateRoomList(rooms) {
    roomListUl.innerHTML = "";
    if (!rooms || rooms.length === 0) {
        roomListUl.innerHTML = "<li>Nenhuma sala pública disponível. Crie uma!</li>";
        return;
    }
    rooms.forEach(room => {
        const li = document.createElement("li");
        const modeText = room.mode === "1v1" ? "(1v1)" : "(Times)";
        li.innerHTML = `
            <span>${room.name} ${modeText} (${room.playerCount} jogadores) - ${room.status === "waiting" ? "Aguardando" : "Em Jogo"}</span>
            <button class="join-room-button" data-room-id="${room.id}" ${room.status !== "waiting" ? "disabled" : ""}>
                ${room.status === "waiting" ? "Entrar" : "Em Jogo"}
            </button>
        `;
        roomListUl.appendChild(li);
    });
    document.querySelectorAll(".join-room-button").forEach(button => {
        button.addEventListener("click", () => {
            const roomId = button.dataset.roomId;
            const playerName = playerNameInput.value.trim();
            if (!playerName) {
                showError(lobbyErrorP, "Por favor, insira seu nome antes de entrar em uma sala.");
                return;
            }
            currentPlayerName = playerName;
            // Send profile pic data along with join request
            socket.emit("joinRoom", roomId, playerName, playerProfilePicDataUrl);
        });
    });
}

function updateWaitingRoomUI(roomData) {
    currentRoom = roomData;
    waitingRoomTitle.textContent = `Sala: ${roomData.name}`;
    waitingRoomModeP.textContent = `Modo: ${roomData.mode === "1v1" ? "1 contra 1" : "Times"}`;
    const playerCount = Object.keys(roomData.players).length;
    waitingPlayerCountSpan.textContent = playerCount;
    waitingPlayersUl.innerHTML = "";
    Object.values(roomData.players).forEach(player => {
        const li = document.createElement("li");
        const img = document.createElement("img");
        img.src = player.profilePic || DEFAULT_PROFILE_PIC;
        img.alt = `Foto de ${player.name}`;
        img.classList.add("player-list-pic");
        li.appendChild(img);
        li.appendChild(document.createTextNode(player.name + (player.id === roomData.leaderId ? " (Líder)" : "")));
        waitingPlayersUl.appendChild(li);
    });
    isLeader = (socket.id === roomData.leaderId);
    if (isLeader) {
        startGameButton.classList.remove("hidden");
        waitingMessageP.textContent = "Você é o líder. Inicie o jogo quando estiver pronto!";
        const requiredPlayers = roomData.mode === "1v1" ? 2 : (gameDataCache.minPlayersToStart || 2);
        startGameButton.disabled = playerCount < requiredPlayers;
        if (roomData.mode === "1v1" && playerCount !== 2) {
             startGameButton.disabled = true;
             waitingMessageP.textContent = "Aguardando exatamente 2 jogadores para iniciar o 1v1.";
        }
    } else {
        startGameButton.classList.add("hidden");
        waitingMessageP.textContent = "Aguardando o líder iniciar o jogo...";
    }
    waitingChatMessagesDiv.innerHTML = "";
    roomData.chat.forEach(msg => displayChatMessage(msg.sender, msg.text, msg.teamId, waitingChatMessagesDiv, msg.senderId));
}

function updateGameUI(roomData) {
    currentRoom = roomData;
    currentRoomIdSpan.textContent = roomData.id;
    gameModeDisplaySpan.textContent = roomData.mode === "1v1" ? "1 contra 1" : "Times";
    maxRoundsSpan.textContent = roomData.gameState.maxRounds || "?";
    if (roomData.mode === "team") {
        updateTeamScoreboard(roomData.teams);
        updateVisualTrail(roomData.teams);
    } else {
        updatePlayerScoreboard(roomData.players);
        updateVisualTrail(roomData.players);
    }
    chatMessagesDiv.innerHTML = "";
    roomData.chat.forEach(msg => displayChatMessage(msg.sender, msg.text, msg.teamId, chatMessagesDiv, msg.senderId));
}

// Specific scoreboard update for Team mode
function updateTeamScoreboard(teamsData) {
    if (!teamsData) return;
    scoreboardListUl.innerHTML = "";
    Object.values(teamsData).forEach((team, index) => {
        if (team.players.length > 0) {
            const teamElement = document.createElement("li");
            const playerNames = team.players.map(pId => team.allPlayers?.[pId]?.name || "...").join(", ");
            const markerId = `team${index + 1}`; // Consistent marker ID
            teamElement.dataset.markerId = markerId;
            // Add team picture? Maybe average of player pics?
            teamElement.innerHTML = `<strong>${team.name}</strong> (Score: ${team.score}, Trilha: ${team.trailPosition})<br><small>Jogadores: ${playerNames || "Nenhum"}</small>`;
            teamElement.dataset.teamId = team.id;
            scoreboardListUl.appendChild(teamElement);
        }
    });
}

// Specific scoreboard update for 1v1 mode
function updatePlayerScoreboard(playersData) {
    if (!playersData) return;
    scoreboardListUl.innerHTML = "";
    Object.values(playersData).forEach((player, index) => {
        const playerElement = document.createElement("li");
        const markerId = `player${index}`; // Consistent marker ID
        playerElement.dataset.markerId = markerId;
        const img = document.createElement("img");
        img.src = player.profilePic || DEFAULT_PROFILE_PIC;
        img.alt = `Foto de ${player.name}`;
        img.classList.add("scoreboard-pic");
        playerElement.appendChild(img);
        const textSpan = document.createElement("span");
        textSpan.innerHTML = `<strong>${player.name}</strong> (Score: ${player.score}, Trilha: ${player.trailPosition})`;
        playerElement.appendChild(textSpan);
        playerElement.dataset.playerId = player.id;
        scoreboardListUl.appendChild(playerElement);
    });
}

function displayChatMessage(sender, text, teamId, chatBoxElement, senderId) {
    const messageElement = document.createElement("p");
    const teamName = currentRoom?.teams?.[teamId]?.name || "";
    const senderDisplay = teamName ? `${sender} (${teamName})` : sender;

    // Add profile pic to chat message
    const senderPic = currentRoom?.players?.[senderId]?.profilePic || DEFAULT_PROFILE_PIC;
    const img = document.createElement("img");
    img.src = senderPic;
    img.alt = `Foto de ${sender}`;
    img.classList.add("chat-pic");
    messageElement.appendChild(img);

    const messageContent = document.createElement("span");
    messageContent.innerHTML = `<strong>${senderDisplay}:</strong> `;
    messageContent.appendChild(document.createTextNode(text));
    messageElement.appendChild(messageContent);

    chatBoxElement.appendChild(messageElement);
    chatBoxElement.scrollTop = chatBoxElement.scrollHeight;
    messageElement.style.animation = "fadeIn 0.3s ease-out";
}

function displaySkillCards(skills) {
    skillCardsDiv.innerHTML = "";
    if (!skills || skills.length === 0) {
        skillCardsDiv.innerHTML = "<p>Nenhuma habilidade disponível.</p>";
        return;
    }
    skills.forEach(skill => {
        const card = document.createElement("div");
        card.classList.add("skill-card");
        card.dataset.skillId = skill.id;
        card.innerHTML = `<span>${skill.nome}</span>`;
        card.title = skill.descricao || "";
        card.addEventListener("click", () => {
            if (!card.classList.contains("disabled") && !card.classList.contains("selected")) {
                document.querySelectorAll(".skill-card.selected").forEach(c => c.classList.remove("selected"));
                card.classList.add("selected");
                socket.emit("chooseSkill", skill.id);
            }
        });
        skillCardsDiv.appendChild(card);
    });
}

function disableSkillCards(message = "") {
    document.querySelectorAll(".skill-card").forEach(card => {
        card.classList.add("disabled");
    });
}

function enableSkillCards() {
    document.querySelectorAll(".skill-card").forEach(card => {
        card.classList.remove("disabled");
        card.classList.remove("selected");
    });
}

function showRouletteAnimation(duration = 2500) {
    situationTextP.classList.add("hidden");
    roulettePlaceholder.classList.remove("hidden");
    if (rouletteTimeout) clearTimeout(rouletteTimeout);
    rouletteTimeout = setTimeout(() => {
        roulettePlaceholder.classList.add("hidden");
        situationTextP.classList.remove("hidden");
    }, duration);
}

function updateRoundEndUI(results, roundData) {
    console.log("Round End Results:", results);
    if (roundData.mode === "team") {
        updateTeamScoreboard(roundData.teams);
        updateVisualTrail(roundData.teams);
    } else {
        updatePlayerScoreboard(roundData.players);
        updateVisualTrail(roundData.players);
    }

    let resultText = "<strong>Resultados da Rodada:</strong><br>";
    Object.entries(results).forEach(([id, result]) => {
        const name = (roundData.mode === "team" ? roundData.teams[id]?.name : roundData.players[id]?.name) || id;
        const skillName = gameDataCache.habilidadesMap?.[result.choice] || "Nenhuma Escolha";
        resultText += `${name}: ${skillName} (+${result.score} pontos)${result.advancedTrail ? " - Avançou na Trilha!" : ""}<br>`;
    });
    roulettePlaceholder.classList.add("hidden");
    situationTextP.classList.remove("hidden");
    situationTextP.innerHTML = resultText;
}

function displayFinalResults(data) {
    stopTimer();
    switchView("game");
    resultsArea.classList.remove("hidden");
    skillsArea.classList.add("hidden");
    situationArea.classList.add("hidden");
    gameOverMessageP.textContent = data.message;
    finalScoresDiv.innerHTML = "<h4>Placar Final:</h4>";
    const scoreList = document.createElement("ul");
    Object.values(data.finalScores).sort((a, b) => b.finalScore - a.finalScore).forEach(entry => {
        const li = document.createElement("li");
        const img = document.createElement("img");
        img.src = entry.profilePic || DEFAULT_PROFILE_PIC;
        img.alt = `Foto de ${entry.name}`;
        img.classList.add("scoreboard-pic");
        li.appendChild(img);
        const textSpan = document.createElement("span");
        textSpan.innerHTML = `<strong>${entry.name}:</strong> ${entry.finalScore} pontos (Score: ${entry.score}, Trilha: ${entry.trailPosition})`;
        if (data.winners.includes(entry.id)) {
            textSpan.innerHTML += " 🏆";
        }
        li.appendChild(textSpan);
        scoreList.appendChild(li);
    });
    finalScoresDiv.appendChild(scoreList);
    generatePersonalityChart(data.skillUsage, data.skillNames, data.mode);
}

function generatePersonalityChart(skillUsageData, skillNameMap, gameMode) {
    gameDataCache.habilidadesMap = skillNameMap;
    const ctx = personalityChartCanvas.getContext("2d");
    const datasets = [];
    const labels = Object.values(skillNameMap);
    const skillIds = Object.keys(skillNameMap);

    Object.entries(skillUsageData).forEach(([id, usage]) => {
        let name = "Desconhecido";
        let entityExists = false;
        if (gameMode === "team") {
            const team = currentRoom?.teams?.[id];
            if (team) {
                name = team.name || `Time ${id}`;
                entityExists = team.players.length > 0;
            }
        } else {
            const player = currentRoom?.players?.[id];
            if (player) {
                name = player.name || `Jogador ${id}`;
                entityExists = true;
            }
        }
        if (!entityExists) return; // Skip if player/team left

        const data = skillIds.map(skillId => usage[skillId] || 0);
        const color = `hsla(${Math.random() * 360}, 70%, 60%, 0.7)`;
        datasets.push({
            label: name,
            data: data,
            backgroundColor: color,
            borderColor: color.replace("0.7", "1"),
            borderWidth: 1
        });
    });

    if (personalityChart) {
        personalityChart.destroy();
    }
    const chartTitle = gameMode === "team" ? "Frequência de Uso de Habilidades por Time" : "Frequência de Uso de Habilidades por Jogador";
    personalityChart = new Chart(ctx, {
        type: "bar",
        data: { labels: labels, datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: chartTitle, font: { size: 16 } },
                legend: { position: "top" }
            },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: "Número de Vezes Escolhida" }, ticks: { stepSize: 1 } },
                x: { title: { display: true, text: "Habilidades" } }
            }
        }
    });
}

// --- Visual Trail Functions ---
function initializeVisualTrail() {
    visualTrailDiv.innerHTML = "."; // Clear previous
    const line = document.createElement("div");
    line.classList.add("trail-line");
    visualTrailDiv.appendChild(line);

    for (let i = 0; i <= MAX_TRAIL_STEPS; i++) {
        const step = document.createElement("div");
        step.classList.add("trail-step");
        step.style.left = `${(i / MAX_TRAIL_STEPS) * 100}%`;
        if (i === 0) {
            step.classList.add("start");
            step.textContent = "I";
        } else if (i === MAX_TRAIL_STEPS) {
            step.classList.add("finish");
            step.textContent = "F";
        } else {
            // step.textContent = i;
        }
        visualTrailDiv.appendChild(step);
    }
    trailInitialized = true;
}

function updateVisualTrail(data) { // Accepts teams or players object
    if (!trailInitialized) initializeVisualTrail();

    // Remove old markers first
    visualTrailDiv.querySelectorAll(".trail-marker").forEach(m => m.remove());

    Object.values(data).forEach((entity, index) => {
        // Determine marker ID based on mode and index
        let markerId = "";
        if (currentRoom.mode === "team") {
            if (entity.players.length === 0) return; // Skip empty teams
            markerId = `team${index + 1}`;
        } else {
            markerId = `player${index}`;
        }

        const marker = document.createElement("div");
        marker.classList.add("trail-marker");
        marker.dataset.markerId = markerId;
        marker.title = entity.name; // Show name on hover

        // Add profile pic to marker if player
        if (currentRoom.mode === "1v1" && entity.profilePic) {
            const img = document.createElement("img");
            img.src = entity.profilePic;
            img.alt = "";
            marker.appendChild(img);
        } else {
            marker.textContent = entity.name.substring(0, 1).toUpperCase(); // Initial for teams or no pic
        }

        const position = Math.min(entity.trailPosition, MAX_TRAIL_STEPS);
        const percentage = (position / MAX_TRAIL_STEPS) * 100;
        marker.style.left = `${percentage}%`;

        visualTrailDiv.appendChild(marker);
    });
}

// --- Event Listeners ---
// Lobby
profilePicUploadInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) {
        profilePicPreviewImg.src = DEFAULT_PROFILE_PIC;
        playerProfilePicDataUrl = null;
        return;
    }

    // Validate type
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        showError(lobbyErrorP, "Formato de imagem inválido. Use JPG, PNG ou WEBP.");
        profilePicUploadInput.value = ""; // Clear the input
        profilePicPreviewImg.src = DEFAULT_PROFILE_PIC;
        playerProfilePicDataUrl = null;
        return;
    }

    // Validate size
    if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
        showError(lobbyErrorP, `Imagem muito grande. O limite é ${MAX_IMAGE_SIZE_MB}MB.`);
        profilePicUploadInput.value = ""; // Clear the input
        profilePicPreviewImg.src = DEFAULT_PROFILE_PIC;
        playerProfilePicDataUrl = null;
        return;
    }

    // Read and display preview
    const reader = new FileReader();
    reader.onload = (e) => {
        profilePicPreviewImg.src = e.target.result;
        playerProfilePicDataUrl = e.target.result; // Store Base64 data
        console.log("Profile picture loaded and stored.");
    };
    reader.onerror = (e) => {
        showError(lobbyErrorP, "Erro ao ler a imagem.");
        profilePicPreviewImg.src = DEFAULT_PROFILE_PIC;
        playerProfilePicDataUrl = null;
    };
    reader.readAsDataURL(file);
});

createRoomButton.addEventListener("click", () => {
    const playerName = playerNameInput.value.trim();
    const roomName = newRoomNameInput.value.trim();
    const gameMode = gameModeSelect.value;
    if (!playerName) {
        showError(lobbyErrorP, "Por favor, insira seu nome para criar uma sala.");
        return;
    }
    currentPlayerName = playerName;
    // Send profile pic data along with create request
    socket.emit("createRoom", playerName, roomName, gameMode, playerProfilePicDataUrl);
});

// Waiting Room
startGameButton.addEventListener("click", () => {
    if (currentRoom && isLeader) {
        console.log("Tentando iniciar o jogo...");
        socket.emit("startGame", currentRoom.id);
        startGameButton.disabled = true;
        startGameButton.textContent = "Iniciando...";
    }
});

leaveRoomButton.addEventListener("click", () => {
    if (currentRoom) {
        socket.emit("leaveRoom");
        switchView("lobby");
        currentRoom = null;
        isLeader = false;
    }
});

waitingSendChatButton.addEventListener("click", sendWaitingMessage);
waitingChatInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
        sendWaitingMessage();
        event.preventDefault();
    }
});

function sendWaitingMessage() {
    const message = waitingChatInput.value.trim();
    if (message && currentRoom) {
        socket.emit("sendMessage", message);
        waitingChatInput.value = "";
    }
}

// Game
sendChatButton.addEventListener("click", sendGameMessage);
chatInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
        sendGameMessage();
        event.preventDefault();
    }
});

function sendGameMessage() {
    const message = chatInput.value.trim();
    if (message && currentRoom) {
        socket.emit("sendMessage", message);
        chatInput.value = "";
    }
}

// Results
backToLobbyButton.addEventListener("click", () => {
    switchView("lobby");
    currentRoom = null;
    isLeader = false;
});

// --- Socket.IO Event Handlers ---
socket.on("connect", () => {
    console.log("Conectado ao servidor com ID:", socket.id);
    currentPlayerId = socket.id;
    if (currentView !== "lobby") {
        switchView("lobby");
    }
});

socket.on("disconnect", (reason) => {
    console.log("Desconectado do servidor:", reason);
    showError(lobbyErrorP, "Você foi desconectado. Atualize a página para reconectar.");
    switchView("lobby");
    currentRoom = null;
    isLeader = false;
    stopTimer();
});

socket.on("roomListUpdate", (rooms) => {
    console.log("Lista de salas atualizada:", rooms);
    if (currentView === "lobby") {
        updateRoomList(rooms);
    }
});

socket.on("joinError", (message) => {
    if (currentView === "lobby") {
        showError(lobbyErrorP, message);
    } else if (currentView === "waiting") {
        showError(waitingErrorP, message);
    }
    currentRoom = null;
    isLeader = false;
});

socket.on("gameError", (message) => {
    if (currentView === "waiting") {
        showError(waitingErrorP, message);
        if (message.includes("iniciar") && isLeader && currentRoom) {
            const playerCount = Object.keys(currentRoom.players).length;
            const requiredPlayers = currentRoom.mode === "1v1" ? 2 : (gameDataCache.minPlayersToStart || 2);
            startGameButton.disabled = playerCount < requiredPlayers;
             if (currentRoom.mode === "1v1" && playerCount !== 2) startGameButton.disabled = true;
            startGameButton.textContent = "Iniciar Jogo";
        }
    } else if (currentView === "game") {
        console.error("Game Error:", message);
        alert(`Erro no jogo: ${message}`);
    }
});

socket.on("joinedRoom", (roomData) => {
    console.log("Entrou na sala:", roomData);
    gameDataCache.minPlayersToStart = roomData.minPlayersToStart;
    switchView("waiting");
    updateWaitingRoomUI(roomData);
});

socket.on("playerJoined", (data) => {
    console.log("Jogador entrou:", data);
    if (currentView === "waiting" && currentRoom && currentRoom.id === data.roomId) {
        currentRoom.players = data.players;
        currentRoom.teams = data.teams;
        updateWaitingRoomUI(currentRoom);
        displayChatMessage("Sistema", `${data.playerName} entrou na sala.`, null, waitingChatMessagesDiv, null); // System message has no pic
    }
});

socket.on("playerLeft", (data) => {
    console.log("Jogador saiu:", data);
    if (currentRoom && currentRoom.id === data.roomId) {
        delete currentRoom.players[data.playerId];
        if (data.mode === "team" && currentRoom.teams) {
            currentRoom.teams = data.teams;
        }
        if (currentView === "waiting") {
            updateWaitingRoomUI(currentRoom);
            displayChatMessage("Sistema", `${data.playerName} saiu da sala.`, null, waitingChatMessagesDiv, null);
        } else if (currentView === "game") {
            updateGameUI(currentRoom); // Update game scoreboard/player list & trail
            displayChatMessage("Sistema", `${data.playerName} saiu da partida.`, null, chatMessagesDiv, null);
        }
    }
});

socket.on("newLeader", (data) => {
    if (currentView === "waiting" && currentRoom && currentRoom.id === data.roomId) {
        currentRoom.leaderId = data.leaderId;
        updateWaitingRoomUI(currentRoom);
        displayChatMessage("Sistema", `${data.leaderName} é o novo líder da sala.`, null, waitingChatMessagesDiv, null);
    }
});

socket.on("newMessage", (message) => {
    console.log("Nova mensagem recebida:", message);
    if (currentRoom && currentRoom.id === message.roomId) {
        const chatBox = currentView === "waiting" ? waitingChatMessagesDiv : chatMessagesDiv;
        displayChatMessage(message.sender, message.text, message.teamId, chatBox, message.senderId);
    }
});

socket.on("gameStarted", (data) => {
    console.log("Jogo iniciado!", data);
    switchView("game");
    updateGameUI(data.room);
});

socket.on("newRound", (data) => {
    console.log("Nova rodada:", data);
    if (currentView !== "game") switchView("game");
    currentRoundSpan.textContent = data.round;
    showRouletteAnimation();
    situationTextP.textContent = data.situationText;
    displaySkillCards(data.availableSkills);
    enableSkillCards();
    startTimer(data.endTime);
    if (data.mode === "team") {
        updateTeamScoreboard(data.teams);
        updateVisualTrail(data.teams);
    } else {
        updatePlayerScoreboard(data.players);
        updateVisualTrail(data.players);
    }
    document.querySelectorAll(".player-chose, .team-chose").forEach(el => el.classList.remove("player-chose", "team-chose"));
});

socket.on("playerChoiceUpdate", (data) => {
    console.log(`Jogador ${data.playerId} escolheu.`);
    const listElement = currentRoom?.mode === "1v1"
        ? scoreboardListUl.querySelector(`li[data-player-id="${data.playerId}"]`)
        : scoreboardListUl.querySelector(`li[data-team-id="${currentRoom?.players[data.playerId]?.team}"]`);
    if (listElement) {
        listElement.classList.add(currentRoom?.mode === "1v1" ? "player-chose" : "team-chose");
    }
});

socket.on("choiceRegistered", (data) => {
    console.log(`Sua escolha (${data.skillId}) foi registrada.`);
    disableSkillCards("Sua escolha foi registrada. Aguardando...");
    const selectedCard = skillCardsDiv.querySelector(`.skill-card[data-skill-id="${data.skillId}"]`);
    if (selectedCard) {
        selectedCard.classList.add("selected");
    }
});

socket.on("roundEnd", (data) => {
    console.log("Fim da rodada:", data);
    stopTimer();
    disableSkillCards();
    updateRoundEndUI(data.results, data);
});

socket.on("gameOver", (data) => {
    console.log("Fim de jogo:", data);
    stopTimer();
    displayFinalResults(data);
});

// Initial setup
switchView("lobby");
console.log("Script do cliente com Lobby, Roleta, 1v1, Trilha Visual e Upload de Foto carregado.");

