// ==========================================================
// スマホ用コントローラー
//
// ・ジャイロ(傾き)を読み取り、rooms/{roomId}/aim に
//   照準位置(0〜1)を送信し続けます。
// ・ボタンを押すたびにFirebase上のfireCounterを1増やし、
//   発射を伝えます。
// ・PC画面に表示された接続コード（またはQRコード経由の
//   URL）で、遊びたいPCの部屋にだけつながります。
//
// 重要：
// Firebaseの読み込みに失敗しても、ジャイロのボタン操作
// 自体は必ず動くように、Firebase関連は接続処理の中だけで
// 扱い、ボタンのイベント登録はそれとは独立して行います。
// ==========================================================

import {
    connectToFirebase,
    describeError
} from "./shared/firebase.js";

import {
    normalizeRoomCode,
    isValidRoomCode,
    getRoomCodeFromUrl
} from "./shared/room-code.js";


// ==========================================================
// ジャイロ照準の設定
// ==========================================================

/*
   中心からどれくらい傾けたら画面の端まで照準が動くか（度数）。
   小さくするほど少しの傾きで大きく動きます。
*/
const SENSITIVITY_X_DEGREES = 40;
const SENSITIVITY_Y_DEGREES = 35;

/* 左右の傾きと照準の動きが逆に感じる場合はtrueに変更 */
const MIRROR_X = true;

/*
   Firebaseへ照準情報を送信する間隔(ミリ秒)。
   短すぎると通信量が増えるので50〜80ms程度がおすすめです。
*/
const AIM_SEND_INTERVAL_MS = 60;


// ==========================================================
// HTML要素
// ==========================================================

const roomSetup = document.getElementById("roomSetup");
const roomForm = document.getElementById("roomForm");
const roomCodeInput = document.getElementById("roomCodeInput");
const roomError = document.getElementById("roomError");

const controller = document.getElementById("controller");
const roomBadgeText = document.getElementById("roomBadgeText");

const fireButton = document.getElementById("fireButton");
const statusText = document.getElementById("status");
const startGyroButton = document.getElementById("startGyroButton");
const recalibrateButton = document.getElementById("recalibrateButton");
const aimDot = document.getElementById("aimDot");
const gyroStatus = document.getElementById("gyroStatus");


// ==========================================================
// Firebase関連の状態
// ==========================================================

let roomId = null;
let firebaseHandles = null;
let connected = false;
let sending = false;


// ==========================================================
// ジャイロ関連の状態
// ==========================================================

/* 最後に受け取った生の傾き(度) */
let lastBeta = 0;
let lastGamma = 0;

/* キャリブレーション基準値。nullのうちは「まだ中心が決まっていない」状態です。 */
let baseBeta = null;
let baseGamma = null;

/* 現在の照準位置（0〜1に正規化） */
let currentAimX = 0.5;
let currentAimY = 0.5;

let gyroActive = false;
let sendTimer = null;


// ==========================================================
// 接続コード（部屋番号）の確定
//
// ・URLに ?room=XXXX があれば、それを使って自動的に接続
// ・なければ、画面に入力フォームを表示して手入力してもらう
// ==========================================================

function activateRoom(code) {

    roomId = code;

    roomBadgeText.textContent = roomId;

    roomSetup.style.display = "none";
    controller.style.display = "flex";

    connectFirebase();
}


function showRoomError(text) {

    roomError.textContent = text;
}


const roomCodeFromUrl = getRoomCodeFromUrl();

if (roomCodeFromUrl) {

    activateRoom(roomCodeFromUrl);

} else {

    roomSetup.style.display = "flex";

    roomForm.addEventListener("submit", function (event) {

        event.preventDefault();

        const normalized = normalizeRoomCode(roomCodeInput.value);

        if (!isValidRoomCode(normalized)) {

            showRoomError(
                "コードは4文字です。もう一度確認してください。"
            );

            return;
        }

        showRoomError("");

        activateRoom(normalized);
    });

    roomCodeInput.addEventListener("input", function () {

        roomCodeInput.value = roomCodeInput.value.toUpperCase();
    });
}


// ==========================================================
// 傾きから照準位置を計算
// ==========================================================

function computeAim() {

    if (baseBeta === null || baseGamma === null) {
        return;
    }

    let deltaGamma = lastGamma - baseGamma;
    let deltaBeta = lastBeta - baseBeta;

    if (MIRROR_X) {
        deltaGamma = -deltaGamma;
    }

    const rawX = 0.5 + (deltaGamma / SENSITIVITY_X_DEGREES);
    const rawY = 0.5 + (deltaBeta / SENSITIVITY_Y_DEGREES);

    currentAimX = Math.min(1, Math.max(0, rawX));
    currentAimY = Math.min(1, Math.max(0, rawY));
}


// ==========================================================
// ジャイロの向きを受け取る
// ==========================================================

function handleOrientation(event) {

    if (typeof event.beta === "number") {
        lastBeta = event.beta;
    }

    if (typeof event.gamma === "number") {
        lastGamma = event.gamma;
    }

    /*
       初めてイベントを受け取ったタイミングで、まだ
       キャリブレーションしていなければ、自動的に
       「今の向き」を中心にします。
    */
    if (baseBeta === null || baseGamma === null) {

        baseBeta = lastBeta;
        baseGamma = lastGamma;

        recalibrateButton.disabled = false;

        gyroStatus.textContent = "ジャイロ：有効（今の向きが中心です）";
    }

    computeAim();
}


// ==========================================================
// 今の向きを中心として設定し直す
// ==========================================================

function recalibrate() {

    baseBeta = lastBeta;
    baseGamma = lastGamma;

    currentAimX = 0.5;
    currentAimY = 0.5;

    gyroStatus.textContent = "ジャイロ：中心を合わせ直しました";

    aimDot.classList.add("centered");

    setTimeout(function () {

        aimDot.classList.remove("centered");

    }, 400);
}


// ==========================================================
// ジャイロを有効化する
//
// iOS 13以降はユーザー操作の中でDeviceOrientationEvent.
// requestPermission()を呼ばないと許可ダイアログが出せません。
//
// Firebaseの状態に関係なく、必ず動作します。
// ==========================================================

async function startGyro() {

    if (gyroActive) {
        return;
    }

    if (typeof DeviceOrientationEvent === "undefined") {

        gyroStatus.textContent = "ジャイロ：このブラウザは非対応です";

        return;
    }

    try {

        if (typeof DeviceOrientationEvent.requestPermission === "function") {

            gyroStatus.textContent = "ジャイロ：許可を確認中…";

            const permission = await DeviceOrientationEvent.requestPermission();

            if (permission !== "granted") {

                gyroStatus.textContent =
                    "ジャイロ：許可されませんでした（設定アプリ→Safari→モーションと画面の向きへのアクセス、を確認）";

                return;
            }
        }

        window.addEventListener("deviceorientation", handleOrientation);

        gyroActive = true;

        startGyroButton.textContent = "① ジャイロ有効化ずみ";
        startGyroButton.classList.add("done");
        startGyroButton.disabled = true;

        gyroStatus.textContent = "ジャイロ：スマホを向けて待機中…";

        startAimSendLoop();

        console.log("ジャイロ読み取り開始");

    } catch (error) {

        gyroStatus.textContent =
            "ジャイロ：起動できませんでした（" + describeError(error) + "）";

        console.error("ジャイロ起動エラー：", error);
    }
}


// ==========================================================
// 照準インジケーター（スマホ画面上のドット）を更新
// ==========================================================

function renderAimDot() {

    aimDot.style.left = (currentAimX * 100) + "%";
    aimDot.style.top = (currentAimY * 100) + "%";

    requestAnimationFrame(renderAimDot);
}


// ==========================================================
// 照準位置をFirebaseへ送り続ける
// ==========================================================

function startAimSendLoop() {

    if (sendTimer) {
        return;
    }

    sendTimer = setInterval(function () {

        if (!connected || !firebaseHandles) {
            return;
        }

        const { ref, set, database } = firebaseHandles;

        const aimReference = ref(database, "rooms/" + roomId + "/aim");

        set(aimReference, {
            x: currentAimX,
            y: currentAimY
        }).catch(function (error) {

            console.warn("照準送信エラー：", error);
        });

    }, AIM_SEND_INTERVAL_MS);
}


// ==========================================================
// 発射情報を送信
// ==========================================================

async function sendShot() {

    if (!connected || !firebaseHandles || sending) {

        console.warn("発射できない状態です", {
            connected,
            hasFirebase: Boolean(firebaseHandles),
            sending
        });

        return;
    }

    sending = true;

    fireButton.classList.add("pressed");

    if ("vibrate" in navigator) {
        navigator.vibrate(35);
    }

    try {

        const { ref, runTransaction, database } = firebaseHandles;

        const counterReference = ref(database, "rooms/" + roomId + "/fireCounter");

        /* 現在の数字に1を足します。 0 → 1 → 2 → 3 */
        const result = await runTransaction(counterReference, function (currentValue) {

            const currentNumber = Number(currentValue) || 0;

            return currentNumber + 1;
        });

        if (!result.committed) {

            throw new Error("発射情報を保存できませんでした");
        }

        const newCounter = result.snapshot.val();

        statusText.textContent = "発射！";

        console.log("発射送信成功：", newCounter);

        setTimeout(function () {

            if (connected) {

                statusText.textContent = "接続済み";
            }

        }, 300);

    } catch (error) {

        statusText.textContent = "送信エラー：" + describeError(error);

        statusText.classList.remove("connected");
        statusText.classList.add("error");

        console.error("発射送信エラー：", error);

    } finally {

        setTimeout(function () {

            sending = false;

            fireButton.classList.remove("pressed");

        }, 120);
    }
}


// ==========================================================
// Firebaseへ接続
//
// CDNへのアクセスに失敗しても、エラーメッセージが
// 画面に表示されるだけで、他の機能（ジャイロ操作）には
// 影響しません。
// ==========================================================

async function connectFirebase() {

    try {

        firebaseHandles = await connectToFirebase(function (text) {

            statusText.textContent = text;
        });

        connected = true;

        fireButton.disabled = false;

        statusText.textContent = "接続済み";

        statusText.classList.remove("error");
        statusText.classList.add("connected");

        /*
           パソコン側に「スマホが接続済み」であることを伝えます。
           これを見て、パソコン画面はQRコード・接続コードの表示を
           消し、ゲーム画面を表示します。

           onDisconnect()を使うことで、スマホのブラウザを閉じたり
           電波が切れたりしたときも、Firebaseサーバー側が自動的に
           falseへ戻してくれます（パソコン側で消し忘れる心配がない）。
        */
        const { ref, set, onDisconnect, database } = firebaseHandles;

        const presenceReference = ref(
            database,
            "rooms/" + roomId + "/phoneConnected"
        );

        onDisconnect(presenceReference).set(false);

        await set(presenceReference, true);

        console.log("スマホ側Firebase接続成功。部屋番号：", roomId);

    } catch (error) {

        connected = false;

        fireButton.disabled = true;

        statusText.textContent = "接続できません：" + describeError(error);

        statusText.classList.remove("connected");
        statusText.classList.add("error");

        console.error("Firebase接続エラー：", error);
    }
}


// ==========================================================
// ボタン操作
//
// この節は、Firebase処理の成否に関係なく必ず実行されます。
// ==========================================================

fireButton.addEventListener("pointerdown", function (event) {

    event.preventDefault();

    sendShot();
});


/*
   ジャイロの許可ダイアログ(DeviceOrientationEvent.requestPermission)は、
   iOSのSafariでは「click」イベントの中で直接呼び出さないと
   信頼できるユーザー操作として扱われず、許可が下りない
   （＝「起動できませんでした」エラーになる）ことがあります。
   "pointerdown"では発生タイミングの違いから許可が下りない
   端末があったため、確実な"click"イベントに変更しています。
*/
startGyroButton.addEventListener("click", function (event) {

    event.preventDefault();

    startGyro();
});


recalibrateButton.addEventListener("pointerdown", function (event) {

    event.preventDefault();

    recalibrate();
});


// ==========================================================
// スペースキーでもテスト可能（PCブラウザでの確認用）
// ==========================================================

window.addEventListener("keydown", function (event) {

    if (event.code === "Space") {

        event.preventDefault();

        sendShot();
    }
});


// ==========================================================
// このスクリプト自体で捕まえきれなかったエラーも、
// コンソールに出して見えるようにします。
// （開発者ツールが開けない環境向けの保険）
// ==========================================================

window.addEventListener("error", function (event) {

    console.error("未処理のエラー：", event.error || event.message);
});

window.addEventListener("unhandledrejection", function (event) {

    console.error("未処理のPromiseエラー：", event.reason);
});


// ==========================================================
// 初期化
//
// ジャイロの見た目更新ループはFirebaseと無関係に、
// 常に動かします。
// ==========================================================

requestAnimationFrame(renderAimDot);
