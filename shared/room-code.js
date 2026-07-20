// ==========================================================
// 接続コード(部屋番号)ユーティリティ
//
// これまでは PC・スマホ双方が固定の部屋名 "main" を
// 使っていました。しかしこのアプリをGitHub Pagesなど
// 誰でもアクセスできる場所に置いた場合、同時に別の人が
// 同じページを開くと、全員が同じ "main" という部屋を
// 取り合ってしまい、ジャイロの値や発射情報が混ざって
// 「うまく接続できない・照準がおかしい」という症状の
// 大きな原因になります。
//
// そこで、PCがゲーム画面を開くたびにランダムな
// 接続コードを発行し、スマホはそのコードを入力（または
// QRコードを読み取る）ことで、1対1のペアだけがつながる
// ようにします。
// ==========================================================


// 紛らわしい文字（0/O、1/I/L など）を除いた文字だけを使う
const ROOM_CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const ROOM_CODE_LENGTH = 4;


// ==========================================================
// ランダムな接続コードを作る（例："7F3K"）
// ==========================================================

export function generateRoomCode() {

    let code = "";

    for (let index = 0; index < ROOM_CODE_LENGTH; index++) {

        const randomIndex = Math.floor(
            Math.random() * ROOM_CODE_CHARS.length
        );

        code += ROOM_CODE_CHARS[randomIndex];
    }

    return code;
}


// ==========================================================
// ユーザーが手入力したコードを、
// 大文字・記号なしの形にそろえる
// ==========================================================

export function normalizeRoomCode(rawCode) {

    if (typeof rawCode !== "string") {
        return "";
    }

    return rawCode
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}


// ==========================================================
// 接続コードとして正しい形かどうか
// ==========================================================

export function isValidRoomCode(code) {

    return (
        typeof code === "string" &&
        code.length === ROOM_CODE_LENGTH
    );
}


// ==========================================================
// URLの ?room=XXXX からコードを取り出す
// ==========================================================

export function getRoomCodeFromUrl() {

    const params = new URLSearchParams(window.location.search);

    const rawCode = params.get("room");

    if (!rawCode) {
        return null;
    }

    const normalized = normalizeRoomCode(rawCode);

    return isValidRoomCode(normalized) ? normalized : null;
}


// ==========================================================
// スマホ用ページのURLを組み立てる
// （index.htmlと同じフォルダにsmartphone.htmlがある前提）
// ==========================================================

export function buildPhoneUrl(roomCode) {

    const phoneUrl = new URL("smartphone.html", window.location.href);

    phoneUrl.searchParams.set("room", roomCode);

    return phoneUrl.toString();
}
