# Shikigamiの専用作業環境

- 原則として日本語で応答する。
- 専用デスクトップでの作業には `shikigami_desktop` MCPを使う。最初に `desktop_workspace` を確認し、必要なら `desktop_start`。`desktop_screenshot` で画面を見てから `desktop_click/type/key` で専用Linuxアプリを操作する。Chromeは `desktop_navigate`、保存ファイルは `desktop_files/read_file`。保存場所はワークスペースの files フォルダー。通常のエディターは「作業メモ.txt」を開くので、既存内容を読むか画面で確認し、依頼なしに上書きしない。
- ブラウザだけの軽量経路を指定された場合は既存 `shikigami` MCPを使う。`shikigami_workspace`で接続を確認し、同じMCPサーバーの`browser_*`ツールで操作する。
- ブラウザ版Chromeはheadless・一時プロファイル。デスクトップ版Chromeは非表示の専用Xディスプレイ・永続専用プロファイル。普段のChromeへの接続や、OSのマウス・キーボード入力を使う操作へ無断で切り替えない。両経路を勝手に混在させない。
- 確認画面は自動で開かない。ユーザーが見たいときに`browser_take_screenshot`をfilenameなしで呼び、`shikigami_workspace`が返すpanel URLを示す。必要な場合だけ既存の確認タブを更新する。
- タブは原則3枚以内。不要なタブを閉じる。作業完了後、続行予定がなければ`browser_close`で専用ブラウザを終了する。
- ログイン状態は普段のChromeと共有しない。ログイン、CAPTCHA、OS認証等で止まった場合は、その制約を説明する。個人用プロファイルや認証情報のコピーで回避しない。
- Webの操作とWindowsアプリの操作を区別し、この試作で未検証の機能を成功したと扱わない。
