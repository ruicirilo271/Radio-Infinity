(() => {
    "use strict";

    const audio = document.getElementById("audio");
    const powerBtn = document.getElementById("powerBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const muteBtn = document.getElementById("muteBtn");
    const muteIcon = document.getElementById("muteIcon");
    const volumeSlider = document.getElementById("volumeSlider");

    const cover = document.getElementById("cover");
    const programName = document.getElementById("programName");
    const trackTitle = document.getElementById("trackTitle");
    const trackArtist = document.getElementById("trackArtist");
    const nextTrack = document.getElementById("nextTrack");
    const nextProgram = document.getElementById("nextProgram");
    const countdown = document.getElementById("countdown");
    const modeBadge = document.getElementById("modeBadge");
    const listenerCount = document.getElementById("listenerCount");

    const connectionDot = document.getElementById("connectionDot");
    const connectionText = document.getElementById("connectionText");
    const headerStatus = document.getElementById("headerStatus");
    const serverStatus = document.getElementById("serverStatus");
    const qualityStatus = document.getElementById("qualityStatus");
    const lisbonClock = document.getElementById("lisbonClock");

    const historyList = document.getElementById("historyList");
    const autoModeBtn = document.getElementById("autoModeBtn");
    const scheduleItems = [...document.querySelectorAll(".schedule-item")];
    const toast = document.getElementById("toast");

    const canvas = document.getElementById("spectrum");
    const ctx = canvas.getContext("2d");

    let playlist = [];
    let trackIndex = 0;
    let currentFolder = null;
    let currentProgram = null;
    let pendingTrack = null;
    let shouldPlay = false;
    let retryCount = 0;
    let reconnectTimer = null;
    let toastTimer = null;
    let currentCoverUrl = null;
    let history = [];
    let manualProgram = null;

    const STORAGE_KEY = "infinity-radio-vercel-v1";
    const OLD_STORAGE_KEYS = [
        "infinity-radio-state-v4",
        "infinity-radio-state-v3",
    ];
    const LEGACY_VOLUME_KEY = "infinity-volume";
    let storageEnabled = true;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function safeLocalGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            storageEnabled = false;
            console.warn("LocalStorage indisponível:", error);
            return null;
        }
    }

    function readLocalState() {
        const candidates = [STORAGE_KEY, ...OLD_STORAGE_KEYS];

        for (const key of candidates) {
            const raw = safeLocalGet(key);
            if (!raw) continue;

            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") return parsed;
            } catch (error) {
                console.warn(`Estado inválido em ${key}:`, error);
            }
        }

        return {};
    }

    function storedNumber(value) {
        if (value === null || value === undefined || value === "") return NaN;
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
    }

    function normaliseHistory(items) {
        if (!Array.isArray(items)) return [];

        return items
            .filter(item => item && typeof item === "object" && item.id)
            .slice(0, 10)
            .map(item => ({
                id: String(item.id),
                title: String(item.title || "Música"),
                artist: String(item.artist || "Infinity Radio"),
                cover: String(item.cover || cover.dataset.default),
                program: String(item.program || "Infinity Radio"),
                time: String(item.time || "--:--"),
            }));
    }

    function normaliseManualProgram(value) {
        if (!value || typeof value !== "object") return null;
        const folder = String(value.folder || "").trim();
        const name = String(value.name || "").trim();
        if (!folder || !name) return null;
        return { folder, name };
    }

    function saveLocalState() {
        if (!storageEnabled) return;

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                version: 1,
                volume: audio.volume,
                history: history.slice(0, 10),
                manualProgram,
                savedAt: new Date().toISOString(),
            }));
            localStorage.setItem(LEGACY_VOLUME_KEY, String(audio.volume));
        } catch (error) {
            storageEnabled = false;
            console.warn("Não foi possível guardar no LocalStorage:", error);
        }
    }

    const savedLocalState = readLocalState();
    const legacyVolume = storedNumber(safeLocalGet(LEGACY_VOLUME_KEY));
    const storedVolume = storedNumber(savedLocalState.volume);
    const initialVolume = Number.isFinite(storedVolume)
        ? storedVolume
        : (Number.isFinite(legacyVolume) && legacyVolume > 0 ? legacyVolume : 0.8);

    audio.volume = clamp(initialVolume, 0.05, 1);
    audio.muted = false;
    volumeSlider.value = String(audio.volume);
    muteIcon.textContent = "🔊";
    history = normaliseHistory(savedLocalState.history);
    manualProgram = normaliseManualProgram(savedLocalState.manualProgram);

    let audioContext = null;
    let analyser = null;
    let sourceNode = null;
    let frequencyData = null;

    function queryString(includeCacheBuster = true) {
        const params = new URLSearchParams();

        if (includeCacheBuster) {
            params.set("v", String(Date.now()));
        }

        if (manualProgram) {
            params.set("folder", manualProgram.folder);
            params.set("name", manualProgram.name);
        }

        return params.toString();
    }

    function apiUrl(path) {
        const query = queryString(true);
        return query ? `${path}?${query}` : path;
    }

    function withCacheBuster(url) {
        const separator = url.includes("?") ? "&" : "?";
        return `${url}${separator}v=${Date.now()}`;
    }

    function showToast(message, isError = false) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle("error", isError);
        toast.classList.add("show");
        toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
    }

    function setConnection(state, text) {
        connectionDot.className = "connection-dot";
        if (state) connectionDot.classList.add(state);
        connectionText.textContent = text;

        if (state === "online") {
            headerStatus.textContent = "EMISSÃO LIGADA";
            document.body.classList.add("is-playing");
        } else if (state === "connecting") {
            headerStatus.textContent = "A LIGAR";
            document.body.classList.remove("is-playing");
        } else if (state === "error") {
            headerStatus.textContent = "A RECONECTAR";
            document.body.classList.remove("is-playing");
        } else {
            headerStatus.textContent = "PRONTA PARA LIGAR";
            document.body.classList.remove("is-playing");
        }
    }

    async function ensureAudioGraph() {
        if (audioContext) {
            if (audioContext.state === "suspended") await audioContext.resume();
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.82;
        sourceNode = audioContext.createMediaElementSource(audio);
        sourceNode.connect(analyser);
        analyser.connect(audioContext.destination);
        frequencyData = new Uint8Array(analyser.frequencyBinCount);
    }

    function roundedRect(context, x, y, width, height, radius) {
        context.beginPath();
        context.moveTo(x + radius, y);
        context.arcTo(x + width, y, x + width, y + height, radius);
        context.arcTo(x + width, y + height, x, y + height, radius);
        context.arcTo(x, y + height, x, y, radius);
        context.arcTo(x, y, x + width, y, radius);
        context.closePath();
    }

    function drawSpectrum() {
        requestAnimationFrame(drawSpectrum);
        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const gradient = ctx.createLinearGradient(0, height, width, 0);
        gradient.addColorStop(0, "rgba(90,114,255,.92)");
        gradient.addColorStop(0.5, "rgba(110,243,255,.95)");
        gradient.addColorStop(1, "rgba(188,92,255,.92)");

        const active = analyser && frequencyData && !audio.paused && !audio.muted;
        if (active) analyser.getByteFrequencyData(frequencyData);

        const bars = 72;
        const gap = 5;
        const barWidth = (width - gap * (bars - 1)) / bars;

        for (let i = 0; i < bars; i += 1) {
            const index = Math.floor((i / bars) * (frequencyData?.length || 1) * 0.72);
            const value = active
                ? frequencyData[index] / 255
                : 0.055 + Math.sin(Date.now() / 720 + i * 0.5) * 0.018;
            const barHeight = Math.max(4, value * (height - 18));
            const x = i * (barWidth + gap);
            const y = height - barHeight;
            ctx.fillStyle = gradient;
            ctx.globalAlpha = active ? 0.95 : 0.28;
            roundedRect(ctx, x, y, barWidth, barHeight, Math.min(7, barWidth / 2));
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function paintVolume() {
        const percentage = Math.round(Number(volumeSlider.value) * 100);
        volumeSlider.style.background =
            `linear-gradient(90deg,var(--cyan) ${percentage}%,rgba(255,255,255,.12) ${percentage}%)`;
    }

    function formatDuration(totalSeconds) {
        if (totalSeconds === null || totalSeconds === undefined) return "MANUAL";
        const seconds = Math.max(0, Number(totalSeconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
    }

    function formatClock(isoDate, seconds = true) {
        if (!isoDate) return "--:--";
        return new Intl.DateTimeFormat("pt-PT", {
            hour: "2-digit",
            minute: "2-digit",
            second: seconds ? "2-digit" : undefined,
            timeZone: "Europe/Lisbon",
        }).format(new Date(isoDate));
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function updateCover(track) {
        const fallback = cover.dataset.default;
        if (currentCoverUrl) {
            URL.revokeObjectURL(currentCoverUrl);
            currentCoverUrl = null;
        }

        fetch(track.cover, { cache: "no-store" })
            .then(response => {
                if (!response.ok) throw new Error("Sem capa");
                return response.blob();
            })
            .then(blob => {
                currentCoverUrl = URL.createObjectURL(blob);
                cover.src = currentCoverUrl;
            })
            .catch(() => {
                cover.src = fallback;
            });
    }

    function renderHistory() {
        if (!history.length) {
            historyList.innerHTML = '<div class="empty-state">O histórico aparece quando ligares a rádio.</div>';
            return;
        }

        const fallback = cover.dataset.default;
        historyList.innerHTML = history.map(item => `
            <div class="history-item">
                <img class="history-cover" src="${escapeHtml(item.cover)}"
                     onerror="this.src='${escapeHtml(fallback)}'" alt="">
                <div class="history-copy">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span>${escapeHtml(item.artist)}</span>
                </div>
                <div class="history-meta">
                    <strong>${escapeHtml(item.program)}</strong>
                    <span>${escapeHtml(item.time)}</span>
                </div>
            </div>
        `).join("");
    }

    function showCurrentTrack(track) {
        trackTitle.textContent = track.title || "Música";
        trackArtist.textContent = track.artist || "Infinity Radio";
        updateCover(track);

        const next = playlist[(trackIndex + 1) % playlist.length];
        nextTrack.textContent = next
            ? `${next.artist} — ${next.title}`
            : "A preparar…";

        if (!history.length || history[0].id !== track.id) {
            history.unshift({
                id: track.id,
                title: track.title,
                artist: track.artist,
                cover: track.cover,
                program: currentProgram || "Infinity Radio",
                time: formatClock(new Date().toISOString(), false),
            });
            history = history.slice(0, 10);
            saveLocalState();
            renderHistory();
        }
    }

    async function loadPlaylist({ autoplay = false, preserveIndex = false } = {}) {
        const response = await fetch(apiUrl("/api/player/playlist"), { cache: "no-store" });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || "Não foi possível carregar a playlist.");
        }

        playlist = Array.isArray(data.tracks) ? data.tracks : [];
        currentFolder = data.program.folder;
        currentProgram = data.program.name;
        programName.textContent = currentProgram;
        modeBadge.textContent = data.program.mode === "manual" ? "MODO MANUAL" : "MODO AUTOMÁTICO";
        modeBadge.classList.toggle("manual", data.program.mode === "manual");
        autoModeBtn.classList.toggle("active", data.program.mode === "auto");

        if (!playlist.length) throw new Error("A pasta deste programa não tem músicas MP3.");
        if (!preserveIndex || trackIndex >= playlist.length) trackIndex = 0;

        const first = playlist[trackIndex];
        const next = playlist[(trackIndex + 1) % playlist.length];
        nextTrack.textContent = next ? `${next.artist} — ${next.title}` : "—";

        if (autoplay && shouldPlay) {
            await playCurrentTrack();
        } else if (!pendingTrack) {
            trackTitle.textContent = first.title;
            trackArtist.textContent = first.artist;
        }
    }

    async function playCurrentTrack() {
        if (!playlist.length) await loadPlaylist();

        clearTimeout(reconnectTimer);
        const track = playlist[trackIndex];
        pendingTrack = track;
        setConnection("connecting", "A carregar um bloco seguro do áudio…");

        audio.pause();
        audio.src = withCacheBuster(track.stream);
        audio.load();
        await audio.play();
    }

    async function startRadio() {
        shouldPlay = true;

        if (audio.volume < 0.05) {
            audio.volume = 0.8;
            volumeSlider.value = "0.8";
            paintVolume();
        }

        audio.muted = false;
        muteIcon.textContent = "🔊";
        saveLocalState();

        await ensureAudioGraph();
        powerBtn.classList.add("active");
        powerBtn.querySelector(".power-icon").textContent = "■";
        powerBtn.querySelector(".power-text").textContent = "DESLIGAR";

        try {
            if (!playlist.length) await loadPlaylist();
            await playCurrentTrack();
        } catch (error) {
            console.error(error);
            shouldPlay = false;
            powerBtn.classList.remove("active");
            powerBtn.querySelector(".power-icon").textContent = "▶";
            powerBtn.querySelector(".power-text").textContent = "LIGAR RÁDIO";
            setConnection("error", "Não foi possível iniciar a emissão");
            showToast(error.message, true);
        }
    }

    function stopRadio() {
        shouldPlay = false;
        clearTimeout(reconnectTimer);
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        pendingTrack = null;
        powerBtn.classList.remove("active");
        powerBtn.querySelector(".power-icon").textContent = "▶";
        powerBtn.querySelector(".power-text").textContent = "LIGAR RÁDIO";
        setConnection("", "Rádio desligada");
    }

    async function nextSong() {
        if (!playlist.length) return;
        retryCount = 0;
        trackIndex = (trackIndex + 1) % playlist.length;
        await playCurrentTrack();
    }

    function retryOrSkip() {
        if (!shouldPlay) return;
        clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(async () => {
            try {
                if (retryCount === 0) {
                    retryCount = 1;
                    await playCurrentTrack();
                } else if (retryCount === 1) {
                    retryCount = 2;
                    await loadPlaylist({ autoplay: true, preserveIndex: true });
                } else {
                    await nextSong();
                }
            } catch (error) {
                console.error(error);
                retryOrSkip();
            }
        }, 1800);
    }

    async function fetchStatus() {
        try {
            const response = await fetch(apiUrl("/api/status"), { cache: "no-store" });
            const status = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(status.error || `HTTP ${response.status}`);

            serverStatus.textContent = "Vercel online";
            qualityStatus.textContent = "MP3 Range + /tmp";
            lisbonClock.textContent = formatClock(status.server_time);
            nextProgram.textContent = status.next_program
                ? `${status.next_program.start} — ${status.next_program.name}`
                : "—";
            countdown.textContent = formatDuration(status.program.seconds_remaining);
            listenerCount.textContent = shouldPlay ? "player ligado" : "player disponível";
            autoModeBtn.classList.toggle("active", status.mode === "auto");

            scheduleItems.forEach(item => {
                item.classList.toggle(
                    "current",
                    item.dataset.folder === status.program.folder &&
                    item.dataset.name === status.program.name
                );
            });

            if (currentFolder && status.program.folder !== currentFolder) {
                trackIndex = 0;
                await loadPlaylist({ autoplay: shouldPlay });
            } else if (!currentFolder) {
                await loadPlaylist({ autoplay: false });
            }
        } catch (error) {
            console.error(error);
            serverStatus.textContent = "Sem resposta";
        }
    }

    powerBtn.addEventListener("click", () => shouldPlay ? stopRadio() : startRadio());

    reconnectBtn.addEventListener("click", async () => {
        try {
            if (!shouldPlay) await startRadio();
            else await playCurrentTrack();
            showToast("Player reconectado.");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    muteBtn.addEventListener("click", () => {
        audio.muted = !audio.muted;
        muteIcon.textContent = audio.muted ? "🔇" : "🔊";
    });

    volumeSlider.addEventListener("input", () => {
        audio.volume = Number(volumeSlider.value);
        audio.muted = false;
        muteIcon.textContent = "🔊";
        paintVolume();
        saveLocalState();
    });

    audio.addEventListener("playing", () => {
        clearTimeout(reconnectTimer);
        retryCount = 0;
        setConnection("online", "Música sincronizada — blocos seguros do Vercel");

        if (pendingTrack) {
            showCurrentTrack(pendingTrack);
            pendingTrack = null;
        }
    });

    audio.addEventListener("ended", () => {
        if (shouldPlay) nextSong().catch(retryOrSkip);
    });

    audio.addEventListener("waiting", () => {
        if (shouldPlay) setConnection("connecting", "A carregar o próximo bloco…");
    });

    audio.addEventListener("stalled", retryOrSkip);
    audio.addEventListener("error", retryOrSkip);

    autoModeBtn.addEventListener("click", async () => {
        try {
            manualProgram = null;
            trackIndex = 0;
            saveLocalState();
            await loadPlaylist({ autoplay: shouldPlay });
            await fetchStatus();
            showToast("Modo automático ativado.");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    scheduleItems.forEach(item => {
        item.addEventListener("click", async () => {
            try {
                manualProgram = {
                    folder: item.dataset.folder,
                    name: item.dataset.name,
                };
                trackIndex = 0;
                saveLocalState();
                await loadPlaylist({ autoplay: shouldPlay });
                await fetchStatus();
                showToast(`Modo manual: ${item.dataset.name}`);
            } catch (error) {
                showToast(error.message, true);
            }
        });
    });

    window.addEventListener("beforeunload", () => {
        saveLocalState();
        if (currentCoverUrl) URL.revokeObjectURL(currentCoverUrl);
    });

    window.addEventListener("storage", event => {
        if (event.key !== STORAGE_KEY || !event.newValue) return;

        try {
            const incoming = JSON.parse(event.newValue);
            history = normaliseHistory(incoming.history);
            const incomingManual = normaliseManualProgram(incoming.manualProgram);
            const modeChanged = JSON.stringify(incomingManual) !== JSON.stringify(manualProgram);
            manualProgram = incomingManual;

            if (Number.isFinite(Number(incoming.volume))) {
                audio.volume = clamp(Number(incoming.volume), 0.05, 1);
                volumeSlider.value = String(audio.volume);
                paintVolume();
            }

            renderHistory();

            if (modeChanged) {
                trackIndex = 0;
                loadPlaylist({ autoplay: shouldPlay }).catch(console.error);
            }
        } catch (error) {
            console.warn("Estado recebido do LocalStorage inválido:", error);
        }
    });

    paintVolume();
    drawSpectrum();
    renderHistory();
    fetchStatus();
    setInterval(fetchStatus, 10000);
})();
