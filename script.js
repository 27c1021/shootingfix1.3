// ==========================================================
// ジャングルバルーンシューティング
// パソコン側
//
// ・Firebaseでスマホの発射を受信
// ・Firebase経由でスマホのジャイロ照準を受信
// ・マウス操作なし
// ・風船の膨らんだ部分だけ当たり判定
//
// ・ページを開くたびにランダムな接続コード（部屋番号）を
//   発行し、QRコード／コード直接入力でスマホと1対1で
//   ペアリングします（複数人が同時に遊んでも混線しません）
// ==========================================================

import {
    connectToFirebase,
    describeError
} from "./shared/firebase.js";

import {
    generateRoomCode,
    buildPhoneUrl
} from "./shared/room-code.js";


// ==========================================================
// ゲーム設定
// ==========================================================

const GAME_TIME = 20;

const START_BALLOON_COUNT = 3;

const LAST_BALLOON_COUNT = 4;

const ADD_BALLOON_TIME = 10;

const GOLD_BALLOON_RATE = 0.1;

const BALLOON_WIDTH = 230;

const BALLOON_HEIGHT = 310;

const SCREEN_MARGIN = 25;

const TOP_MARGIN = 130;


// ==========================================================
// 風船の当たり判定
// ==========================================================

const HIT_CENTER_X = 0.5;

const HIT_CENTER_Y = 0.29;

const HIT_RADIUS_X = 0.25;

const HIT_RADIUS_Y = 0.28;


// ==========================================================
// ジャイロ照準の設定
// ==========================================================

/* 小さいほど滑らか、大きいほど反応が速い */
const AIM_SMOOTH = 0.22;

/*
   スマホからの照準情報がこの時間(ミリ秒)以上届かなかったら
   「未受信」扱いにします。
*/
const AIM_TIMEOUT_MS = 2000;


// ==========================================================
// HTML要素
// ==========================================================

const game = document.getElementById("game");
const balloonArea = document.getElementById("balloonArea");
const scope = document.getElementById("scope");
const shotFlash = document.getElementById("shotFlash");
const timeText = document.getElementById("time");
const scoreText = document.getElementById("score");
const countdown = document.getElementById("countdown");
const instruction = document.getElementById("instruction");
const resultOverlay = document.getElementById("resultOverlay");
const message = document.getElementById("message");
const startButton = document.getElementById("startButton");
const firebaseStatus = document.getElementById("firebaseStatus");
const aimStatus = document.getElementById("aimStatus");
const reconnectButton = document.getElementById("reconnectButton");

const connectionBackdrop = document.getElementById("connectionBackdrop");
const pairingPanel = document.getElementById("pairingPanel");
const qrCodeContainer = document.getElementById("qrCodeContainer");
const roomCodeText = document.getElementById("roomCodeText");
const regenerateRoomButton = document.getElementById("regenerateRoomButton");


// ==========================================================
// 必須要素の確認
// ==========================================================

const requiredElements = {
    game, balloonArea, scope, shotFlash, timeText, scoreText,
    countdown, instruction, resultOverlay, message, startButton,
    firebaseStatus, aimStatus, reconnectButton, connectionBackdrop,
    pairingPanel, qrCodeContainer, roomCodeText, regenerateRoomButton
};

for (const [name, element] of Object.entries(requiredElements)) {

    if (!element) {
        console.error("HTML要素が見つかりません：", name);
    }
}


// ==========================================================
// 風船データ
// ==========================================================

const normalBalloons = [
    { image: "images/redballoon.png", points: 1, type: "normal" },
    { image: "images/blueballoon.png", points: 1, type: "normal" },
    { image: "images/yellowballoon.png", points: 1, type: "normal" }
];

const goldBalloon = {
    image: "images/goldballoon.png",
    points: 5,
    type: "gold"
};


// ==========================================================
// 効果音
// ==========================================================

const shotSound = new Audio("sound/shot.mp3");
const popSound = new Audio("sound/hit.mp3");
const missSound = new Audio("sound/miss.mp3");
const clearSound = new Audio("sound/clear.mp3");

shotSound.volume = 0.42;
popSound.volume = 0.68;
missSound.volume = 0.5;
clearSound.volume = 0.72;


// ==========================================================
// ゲーム中に変化する値
// ==========================================================

let score = 0;
let time = GAME_TIME;
let playing = false;
let countdownRunning = false;
let gameTimer = null;
let extraBalloonAdded = false;
let balloonId = 0;


// ==========================================================
// ジャイロ照準関連
// ==========================================================

let aimX = window.innerWidth / 2;
let aimY = window.innerHeight / 2;
let targetAimX = aimX;
let targetAimY = aimY;

/*
   スマホから最後に照準情報を受信した時刻(ミリ秒)。
   AIM_TIMEOUT_MSと比較して「未受信」表示に使います。
*/
let lastAimReceivedAt = 0;


// ==========================================================
// 接続コード（部屋番号）関連
//
// ページを開くたびに新しいコードを発行します。
// 同じタブ内でリロードしても同じコードを保てるよう、
// sessionStorageに記憶しておきます。
// ==========================================================

const SESSION_STORAGE_KEY = "balloonShooting.roomCode";

let roomId = null;


function resolveRoomId() {

    const savedRoomId = sessionStorage.getItem(SESSION_STORAGE_KEY);

    if (savedRoomId) {
        return savedRoomId;
    }

    const newRoomId = generateRoomCode();

    sessionStorage.setItem(SESSION_STORAGE_KEY, newRoomId);

    return newRoomId;
}


function renderQrCode(text) {

    qrCodeContainer.innerHTML = "";

    if (typeof window.qrcode !== "function") {

        // ライブラリが読み込めなくても、コード直接入力で遊べます
        const fallbackText = document.createElement("div");

        fallbackText.textContent =
            "（QRコードを表示できません。コードを直接入力してください）";

        fallbackText.style.fontSize = "12px";

        qrCodeContainer.appendChild(fallbackText);

        return;
    }

    try {

        const qr = window.qrcode(0, "M");

        qr.addData(text);

        qr.make();

        qrCodeContainer.innerHTML = qr.createImgTag(4, 4);

    } catch (error) {

        console.warn("QRコードの生成に失敗しました：", error);
    }
}


function setupPairing() {

    roomId = resolveRoomId();

    roomCodeText.textContent = roomId;

    renderQrCode(buildPhoneUrl(roomId));
}


regenerateRoomButton.addEventListener("click", function () {

    sessionStorage.removeItem(SESSION_STORAGE_KEY);

    // 部屋を切り替えるので、接続を最初からやり直します
    location.reload();
});


// ==========================================================
// 照準をなめらかに追従させるループ
// （requestAnimationFrameで毎フレーム実行）
// ==========================================================

function animateAim() {

    aimX += (targetAimX - aimX) * AIM_SMOOTH;
    aimY += (targetAimY - aimY) * AIM_SMOOTH;

    updateScopePosition();

    /*
       一定時間ジャイロ情報が届いていなければ
       「未受信」表示に戻します。
    */
    if (
        lastAimReceivedAt !== 0 &&
        Date.now() - lastAimReceivedAt > AIM_TIMEOUT_MS
    ) {

        aimStatus.textContent = "未受信";
        aimStatus.classList.remove("connected");
        scope.classList.remove("detected");
    }

    requestAnimationFrame(animateAim);
}


// ==========================================================
// Firebase関連
// ==========================================================

let firebaseHandles = null;

/* 初回読み込み時に現在の発射番号を記憶します。 */
let lastFireCounter = null;


// ==========================================================
// 効果音を再生
// ==========================================================

function playSound(sound) {

    const soundCopy = sound.cloneNode();

    soundCopy.volume = sound.volume;
    soundCopy.currentTime = 0;

    soundCopy.play().catch(function (error) {

        console.warn("効果音を再生できません：", error);
    });
}


// ==========================================================
// Firebaseへ接続
// ==========================================================

async function connectFirebase() {

    reconnectButton.style.display = "none";

    try {

        firebaseHandles = await connectToFirebase(function (statusText) {

            firebaseStatus.textContent = statusText;
        });

        firebaseStatus.textContent = "受信準備中";

        console.log("Firebase匿名認証成功。部屋番号：", roomId);

        listenForShots();
        listenForAim();
        listenForPhoneConnection();

    } catch (error) {

        firebaseStatus.textContent =
            "接続エラー：" + describeError(error);

        console.error("Firebase接続エラー：", error);

        reconnectButton.style.display = "inline-block";
    }
}


reconnectButton.addEventListener("click", function () {

    connectFirebase();
});


// ==========================================================
// スマホの発射番号を監視
// ==========================================================

function listenForShots() {

    const { ref, onValue, database } = firebaseHandles;

    const fireCounterReference = ref(
        database,
        "rooms/" + roomId + "/fireCounter"
    );

    onValue(
        fireCounterReference,

        function (snapshot) {

            const currentCounter = Number(snapshot.val()) || 0;

            /*
               最初の読み込み時は、現在の番号を記録するだけです。
            */
            if (lastFireCounter === null) {

                lastFireCounter = currentCounter;

                firebaseStatus.textContent = "受信準備完了";

                console.log("発射受信準備完了：", currentCounter);

                return;
            }

            /* 数字が変わっていなければ無視 */
            if (currentCounter === lastFireCounter) {
                return;
            }

            console.log("スマホから発射を受信：", {
                前回: lastFireCounter,
                今回: currentCounter
            });

            lastFireCounter = currentCounter;

            firebaseStatus.textContent = "発射受信！";

            /* 現在の照準位置へ発射 */
            shootAt(aimX, aimY);

            setTimeout(function () {

                firebaseStatus.textContent = "受信準備完了";

            }, 350);
        },

        function (error) {

            firebaseStatus.textContent = "受信エラー";

            console.error("Firebase受信エラー：", error);

            reconnectButton.style.display = "inline-block";
        }
    );
}


// ==========================================================
// スマホのジャイロ照準を監視
//
// スマホ側(phone.js)が rooms/{roomId}/aim に
// { x: 0〜1, y: 0〜1 } を書き込み続けるので、
// それを画面上の座標に変換します。
// ==========================================================

function listenForAim() {

    const { ref, onValue, database } = firebaseHandles;

    const aimReference = ref(
        database,
        "rooms/" + roomId + "/aim"
    );

    onValue(
        aimReference,

        function (snapshot) {

            const aimData = snapshot.val();

            if (
                !aimData ||
                typeof aimData.x !== "number" ||
                typeof aimData.y !== "number"
            ) {
                return;
            }

            /*
               0〜1の範囲にクランプしてから、
               画面のピクセル座標へ変換します。
            */
            const normalizedX = Math.min(1, Math.max(0, aimData.x));
            const normalizedY = Math.min(1, Math.max(0, aimData.y));

            targetAimX = normalizedX * window.innerWidth;
            targetAimY = normalizedY * window.innerHeight;

            lastAimReceivedAt = Date.now();

            aimStatus.textContent = "受信中";
            aimStatus.classList.add("connected");

            scope.classList.add("detected");
        },

        function (error) {

            console.error("ジャイロ照準の受信エラー：", error);
        }
    );
}


// ==========================================================
// スマホの接続状態（プレゼンス）を監視
//
// スマホ側(phone.js)がFirebase接続に成功すると
// rooms/{roomId}/phoneConnected に true を書き込みます
// （スマホが切断されるとFirebase側が自動的にfalseへ戻します）。
//
// これを見て、パソコン側はQRコード・接続コードの画面を消し、
// 代わりにゲーム画面（背景の全画面カバーを外した状態）を
// 表示します。
// ==========================================================

function listenForPhoneConnection() {

    const { ref, onValue, database } = firebaseHandles;

    const presenceReference = ref(
        database,
        "rooms/" + roomId + "/phoneConnected"
    );

    onValue(
        presenceReference,

        function (snapshot) {

            const isPhoneConnected = snapshot.val() === true;

            /*
               "paired"クラスがついている間、CSS側で
               #connectionBackdropと#pairingPanelを非表示にします。
               スマホが切断された場合は再びクラスを外し、
               QRコード・接続コードの画面へ自動的に戻します。
            */
            game.classList.toggle("paired", isPhoneConnected);
        },

        function (error) {

            console.error("スマホの接続状態の受信エラー：", error);
        }
    );
}


// ==========================================================
// 照準位置を更新
// ==========================================================

function updateScopePosition() {

    scope.style.left = aimX + "px";
    scope.style.top = aimY + "px";
}


// ==========================================================
// ランダムな風船を選ぶ
// ==========================================================

function getRandomBalloonData() {

    if (Math.random() < GOLD_BALLOON_RATE) {

        console.log("ゴールド風船が出現");

        return goldBalloon;
    }

    const randomIndex = Math.floor(Math.random() * normalBalloons.length);

    return normalBalloons[randomIndex];
}


// ==========================================================
// 風船情報を設定
// ==========================================================

function applyBalloonData(balloon, balloonData) {

    balloon.classList.remove("gold");

    balloon.src = balloonData.image;
    balloon.dataset.points = balloonData.points;
    balloon.dataset.type = balloonData.type;

    if (balloonData.type === "gold") {

        balloon.classList.add("gold");
    }
}


// ==========================================================
// 風船を1個作る
// ==========================================================

function createBalloon() {

    const balloon = document.createElement("img");

    balloon.classList.add("balloon");
    balloon.alt = "風船";
    balloon.draggable = false;

    balloonId++;
    balloon.dataset.number = balloonId;

    applyBalloonData(balloon, getRandomBalloonData());

    balloon.addEventListener("error", function () {

        console.error("風船画像を読み込めません：", balloon.src);
    });

    balloonArea.appendChild(balloon);

    moveBalloon(balloon);

    return balloon;
}


// ==========================================================
// 風船をランダムな場所へ移動
// ==========================================================

function moveBalloon(balloon) {

    const rect = balloon.getBoundingClientRect();

    const currentWidth = rect.width || BALLOON_WIDTH;
    const currentHeight = rect.height || BALLOON_HEIGHT;

    const maxX = Math.max(
        SCREEN_MARGIN,
        game.clientWidth - currentWidth - SCREEN_MARGIN
    );

    const maxY = Math.max(
        TOP_MARGIN,
        game.clientHeight - currentHeight - SCREEN_MARGIN
    );

    const randomX =
        SCREEN_MARGIN +
        Math.random() * Math.max(0, maxX - SCREEN_MARGIN);

    const randomY =
        TOP_MARGIN +
        Math.random() * Math.max(0, maxY - TOP_MARGIN);

    balloon.style.left = randomX + "px";
    balloon.style.top = randomY + "px";
}


// ==========================================================
// 指定された数まで風船を増やす
// ==========================================================

function setBalloonCount(targetCount) {

    while (balloonArea.children.length < targetCount) {

        createBalloon();
    }
}


// ==========================================================
// 風船をすべて削除
// ==========================================================

function removeAllBalloons() {

    balloonArea.innerHTML = "";
}


// ==========================================================
// 命中した風船を探す
// ==========================================================

function findHitBalloon(shotX, shotY) {

    const balloons = Array.from(
        document.querySelectorAll(".balloon")
    );

    balloons.reverse();

    for (const balloon of balloons) {

        if (balloon.classList.contains("popping")) {
            continue;
        }

        const rect = balloon.getBoundingClientRect();

        const centerX = rect.left + rect.width * HIT_CENTER_X;
        const centerY = rect.top + rect.height * HIT_CENTER_Y;

        const radiusX = rect.width * HIT_RADIUS_X;
        const radiusY = rect.height * HIT_RADIUS_Y;

        const normalizedX = (shotX - centerX) / radiusX;
        const normalizedY = (shotY - centerY) / radiusY;

        const ellipseValue =
            normalizedX * normalizedX + normalizedY * normalizedY;

        if (ellipseValue <= 1) {

            return balloon;
        }
    }

    return null;
}


// ==========================================================
// 指定した座標へ発射
// ==========================================================

function shootAt(shotX, shotY) {

    console.log("発射処理：", {
        x: Math.round(shotX),
        y: Math.round(shotY),
        playing,
        countdownRunning
    });

    /* ゲーム開始後のみ射撃できます。 */
    if (!playing || countdownRunning) {

        console.log("ゲーム中ではないため発射しません");

        return;
    }

    playSound(shotSound);
    playScopeAnimation();
    showShotFlash(shotX, shotY);

    const hitBalloon = findHitBalloon(shotX, shotY);

    if (hitBalloon) {

        handleHit(hitBalloon, shotX, shotY);

    } else {

        playSound(missSound);
    }
}


// ==========================================================
// 照準の発射アニメーション
// ==========================================================

function playScopeAnimation() {

    scope.classList.remove("shooting");

    void scope.offsetWidth;

    scope.classList.add("shooting");

    setTimeout(function () {

        scope.classList.remove("shooting");

    }, 180);
}


// ==========================================================
// 発射位置を光らせる
// ==========================================================

function showShotFlash(x, y) {

    shotFlash.style.left = x + "px";
    shotFlash.style.top = y + "px";

    shotFlash.classList.remove("show");

    void shotFlash.offsetWidth;

    shotFlash.classList.add("show");
}


// ==========================================================
// 命中処理
// ==========================================================

function handleHit(balloon, shotX, shotY) {

    if (balloon.classList.contains("popping")) {
        return;
    }

    const points = Number(balloon.dataset.points);
    const isGold = balloon.dataset.type === "gold";

    playSound(popSound);

    score += points;
    scoreText.textContent = score;

    playScoreBump();
    showScorePopup(shotX, shotY, points, isGold);
    createConfetti(shotX, shotY, isGold);

    balloon.classList.add("popping");

    setTimeout(function () {

        applyBalloonData(balloon, getRandomBalloonData());

        moveBalloon(balloon);

        balloon.classList.remove("popping");

        balloon.style.opacity = "1";

    }, 500);
}


// ==========================================================
// スコアを弾ませる
// ==========================================================

function playScoreBump() {

    scoreText.classList.remove("bump");

    void scoreText.offsetWidth;

    scoreText.classList.add("bump");
}


// ==========================================================
// +1・+5表示
// ==========================================================

function showScorePopup(x, y, points, isGold) {

    const popup = document.createElement("div");

    popup.classList.add("score-popup");

    if (isGold) {
        popup.classList.add("gold");
    }

    popup.textContent = "+" + points;

    popup.style.left = x + "px";
    popup.style.top = y + "px";

    game.appendChild(popup);

    setTimeout(function () {

        popup.remove();

    }, 850);
}


// ==========================================================
// 紙吹雪
// ==========================================================

function createConfetti(x, y, isGold) {

    const confettiCount = isGold ? 30 : 18;

    const normalColors = [
        "#ff3f3f", "#37a9ff", "#ffe144",
        "#ff8a2b", "#55d36b", "#ffffff"
    ];

    const goldColors = [
        "#ffd000", "#fff38a", "#ffffff", "#ffae00"
    ];

    const colors = isGold ? goldColors : normalColors;

    for (let index = 0; index < confettiCount; index++) {

        const piece = document.createElement("div");

        piece.classList.add("confetti");

        const angle = Math.random() * Math.PI * 2;

        const distance =
            75 + Math.random() * (isGold ? 170 : 125);

        const moveX = Math.cos(angle) * distance;
        const moveY = Math.sin(angle) * distance + 50;

        const duration = 0.55 + Math.random() * 0.45;

        const rotate =
            (180 + Math.random() * 720) *
            (Math.random() < 0.5 ? -1 : 1);

        piece.style.left = x + "px";
        piece.style.top = y + "px";

        piece.style.background =
            colors[Math.floor(Math.random() * colors.length)];

        piece.style.width = (6 + Math.random() * 7) + "px";
        piece.style.height = (9 + Math.random() * 11) + "px";

        piece.style.setProperty("--move-x", moveX + "px");
        piece.style.setProperty("--move-y", moveY + "px");
        piece.style.setProperty("--rotate", rotate + "deg");
        piece.style.setProperty("--duration", duration + "s");

        game.appendChild(piece);

        setTimeout(function () {

            piece.remove();

        }, duration * 1000 + 100);
    }
}


// ==========================================================
// カウントダウン
// ==========================================================

function showCountdownText(text) {

    return new Promise(function (resolve) {

        countdown.textContent = text;

        countdown.classList.remove("show");

        countdown.style.display = "block";

        void countdown.offsetWidth;

        countdown.classList.add("show");

        setTimeout(function () {

            countdown.classList.remove("show");

            countdown.style.display = "none";

            resolve();

        }, 760);
    });
}


// ==========================================================
// ゲーム開始
// ==========================================================

async function startGame() {

    if (countdownRunning) {
        return;
    }

    clearInterval(gameTimer);

    score = 0;
    time = GAME_TIME;
    playing = false;
    countdownRunning = true;
    extraBalloonAdded = false;
    balloonId = 0;

    scoreText.textContent = score;
    timeText.textContent = time;

    timeText.classList.remove("danger");

    resultOverlay.style.display = "none";
    message.style.display = "none";
    startButton.style.display = "none";
    instruction.style.display = "none";

    game.classList.add("playing");

    removeAllBalloons();

    await showCountdownText("3");
    await showCountdownText("2");
    await showCountdownText("1");
    await showCountdownText("スタート！");

    setBalloonCount(START_BALLOON_COUNT);

    playing = true;
    countdownRunning = false;

    console.log("ゲーム開始・発射可能");

    gameTimer = setInterval(function () {

        time--;

        timeText.textContent = time;

        if (time <= 5) {

            timeText.classList.add("danger");
        }

        if (time === ADD_BALLOON_TIME && !extraBalloonAdded) {

            extraBalloonAdded = true;

            setBalloonCount(LAST_BALLOON_COUNT);
        }

        if (time <= 0) {

            endGame();
        }

    }, 1000);
}


// ==========================================================
// ゲーム終了
// ==========================================================

function endGame() {

    playing = false;
    countdownRunning = false;

    clearInterval(gameTimer);

    removeAllBalloons();

    timeText.classList.remove("danger");

    playSound(clearSound);

    game.classList.remove("playing");

    resultOverlay.style.display = "block";

    message.innerHTML =
        "タイムアップ！<br>" +
        "スコア<br>" +
        "<strong>" + score + "点</strong>";

    message.style.display = "block";

    startButton.textContent = "もう一度あそぶ";
    startButton.style.display = "block";
}


// ==========================================================
// スタートボタン
// ==========================================================

startButton.addEventListener("click", function (event) {

    event.stopPropagation();

    startGame();
});


// ==========================================================
// スペースキーでパソコン側の発射テスト
// マウスでは発射しません
// ==========================================================

window.addEventListener("keydown", function (event) {

    if (event.code === "Space") {

        event.preventDefault();

        shootAt(aimX, aimY);
    }
});


// ==========================================================
// 画面サイズ変更
// ==========================================================

window.addEventListener("resize", function () {

    if (!playing) {
        return;
    }

    const balloons = document.querySelectorAll(".balloon");

    balloons.forEach(function (balloon) {

        moveBalloon(balloon);
    });
});


// ==========================================================
// 初期化
// ==========================================================

function initializeGame() {

    removeAllBalloons();

    resultOverlay.style.display = "none";
    message.style.display = "none";
    countdown.style.display = "none";

    updateScopePosition();

    setupPairing();
    connectFirebase();

    requestAnimationFrame(animateAim);

    console.log("ゲームの初期化完了・部屋番号：", roomId);
}


initializeGame();
