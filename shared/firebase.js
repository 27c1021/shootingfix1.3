// ==========================================================
// Firebase 共有ヘルパー
//
// パソコン側(script.js)とスマホ側(phone.js)の両方から
// 同じ設定・同じ接続処理を使うための共通モジュールです。
// 同じ内容を2か所に書いてしまうと、片方だけ直して
// 食い違う…という事故が起きやすいので、ここに一本化します。
//
// Firebase SDKは動的import()で読み込みます。
// 先頭でstatic importしていると、CDNへのアクセスに
// 1つでも失敗した瞬間にスクリプト全体が止まり、
// ボタン操作すら反応しなくなるためです。
// ==========================================================


// ==========================================================
// Firebaseプロジェクトの設定
//
// 注意：
// 「接続できない」原因の多くは、コードではなく
// Firebaseコンソール側の設定にあります。特に次の2つを
// 必ず確認してください。
//
//  1) Authentication → Sign-in method →
//     「匿名」（Anonymous）が有効になっているか
//
//  2) Realtime Database → ルール が、
//     少なくとも下記のように rooms 以下を
//     読み書きできる設定になっているか
//
//     {
//       "rules": {
//         "rooms": {
//           "$roomId": {
//             ".read": true,
//             ".write": true
//           }
//         }
//       }
//     }
//
// これらが未設定だと、匿名認証やデータの送受信が
// 権限エラー(permission-denied)で失敗し、
// 「スマホとPCがつながらない」ように見えます。
// ==========================================================

export const firebaseConfig = {
    apiKey:
        "AIzaSyCC7CgZIP6RsU18XK2Vb_7_4nk9Cj_5NcM",

    authDomain:
        "wakutatu-shooting.firebaseapp.com",

    databaseURL:
        "https://wakutatu-shooting-default-rtdb.asia-southeast1.firebasedatabase.app",

    projectId:
        "wakutatu-shooting",

    storageBucket:
        "wakutatu-shooting.firebasestorage.app",

    messagingSenderId:
        "720905273138",

    appId:
        "1:720905273138:web:df97327c6007b5cbc1612b"
};


// ==========================================================
// Firebase読み込み・接続のタイムアウト(ミリ秒)
// ==========================================================

export const FIREBASE_TIMEOUT_MS = 10000;


// ==========================================================
// 何ミリ秒待っても終わらない処理にタイムアウトを付ける
// ==========================================================

export function withTimeout(promise, milliseconds, timeoutMessage) {

    return Promise.race([
        promise,

        new Promise(function (resolve, reject) {

            setTimeout(function () {

                reject(new Error(timeoutMessage));

            }, milliseconds);
        })
    ]);
}


// ==========================================================
// エラー内容を画面に分かりやすく表示するヘルパー
//
// 開発者ツールを開けない状況でも、
// 原因がその場で分かるようにします。
// ==========================================================

export function describeError(error) {

    if (!error) {
        return "不明なエラー";
    }

    if (error.code) {

        // Firebaseのエラーコード（例：auth/operation-not-allowed など）
        return (
            error.code +
            (error.message ? "：" + error.message : "")
        );
    }

    if (error.message) {
        return error.message;
    }

    return String(error);
}


// ==========================================================
// Firebase SDKを動的に読み込み、匿名認証まで済ませます。
//
// onStatus(text) が呼ばれるたびに、進捗メッセージを渡します。
// 呼び出し側はそれを画面に表示するだけでOKです。
//
// 戻り値：
// {
//   database,   // getDatabase()の戻り値
//   ref,        // Firebase Databaseのref関数
//   onValue,    // onValue関数（PC側で使用）
//   set,        // set関数（スマホ側で使用）
//   runTransaction, // runTransaction関数（スマホ側で使用）
//   onDisconnect // 切断時に自動で値を戻すための関数
//                // （スマホ側の接続プレゼンス通知で使用）
// }
// ==========================================================

export async function connectToFirebase(onStatus) {

    const notify = typeof onStatus === "function"
        ? onStatus
        : function () {};

    notify("ライブラリ読み込み中");

    const [appModule, authModule, databaseModule] = await withTimeout(
        Promise.all([
            import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js"),
            import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js"),
            import("https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js")
        ]),
        FIREBASE_TIMEOUT_MS,
        "ライブラリ読み込みタイムアウト"
    );

    const { initializeApp } = appModule;
    const { getAuth, signInAnonymously } = authModule;
    const { getDatabase, ref, onValue, set, runTransaction, onDisconnect } = databaseModule;

    notify("認証中");

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const database = getDatabase(app);

    await withTimeout(
        signInAnonymously(auth),
        FIREBASE_TIMEOUT_MS,
        "認証タイムアウト"
    );

    notify("接続完了");

    return { database, ref, onValue, set, runTransaction, onDisconnect };
}
