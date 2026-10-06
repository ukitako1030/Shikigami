# Shikigamiでのブラウザ作業

- 原則として日本語で応答する。
- このプロジェクトのWebページ操作はShikigami MCPの専用Chromeを使う。`shikigami_workspace`で接続を確認し、同じMCPサーバーの`browser_*`ツールで操作する。
- 専用Chromeはheadless・独立した一時プロファイル。普段のChromeへの接続や、OSのマウス・キーボード入力を使う操作へ無断で切り替えない。
- 確認画面は自動で開かない。ユーザーが見たいときに`browser_take_screenshot`をfilenameなしで呼び、`shikigami_workspace`が返すpanel URLを示す。必要な場合だけ既存の確認タブを更新する。
- タブは原則3枚以内。不要なタブを閉じる。作業完了後、続行予定がなければ`browser_close`で専用ブラウザを終了する。
- ログイン状態は普段のChromeと共有しない。ログイン、CAPTCHA、OS認証等で止まった場合は、その制約を説明する。個人用プロファイルや認証情報のコピーで回避しない。
- Webの操作とWindowsアプリの操作を区別し、この試作で未検証の機能を成功したと扱わない。
