# Shikigami 技術調査・最小試作の結果

検証日：2026年10月6日（日本時間）

2026年10月7日：ブラウザ以外のアプリを操作する専用Linuxデスクトップの試作を追加しました。[デスクトップ版の結果](docs/DESKTOP_LAB.md)に実装・実測・未確認項目を分けて記載しています。以下のブラウザ版と混同しないでください。

公開用レポートです。記載した生ログ・画像・実機情報ファイルはローカルに保管し、リポジトリには含めません。ソースから再検証すると同じ種類の成果物を生成できます。今後の製品仕様は[製品化計画](docs/PRODUCT_PLAN.md)、トップ画面は[デザイン案](docs/design/shikigami-workspace-concept.png)を参照してください。画像は実装済み画面ではありません。

**追記：ユーザー指定により、現在の試作はGoogle Chromeに変更しました。以下の初回同時操作とメモリの数値はEdgeでの実測記録です。Chromeの測定結果とは区別します。**

Chrome切替後の自動検証（21:31頃）：インストール済みChrome 154.0.8037.93を独立した一時プロファイルで起動し、非表示の3タブで入力・クリック・スクロール・ページ遷移を実行。13.5秒で9チェック成功、AIの前面化0／139標本、可視ウィンドウ0／11標本、MCP＋ChromeのWorking Setピーク746.3MiB。プロセス名が`chrome`であることも標本から確認しました。MCP接続・日本語入力・画像応答・確認画面の表示／非表示も再検証成功。人間の同時操作は今回再試行していないため、先の本人確認はEdgeでの結果です。記録は`artifacts/2026-10-06T12-31-14-961Z-report.json`と`artifacts/mcp-contract-chrome.json`。検証後に専用Chromeを終了しました。

現在の推奨構成は **headless Chrome＋独立した一時プロファイル＋Playwright MCP** です。以下は初回Edge検証の記録を保持しています。

### Codex接続の実測記録（22:07）

**グローバル登録と実モデルからの操作を確認済みです。** ユーザーが「接続を続けて」「専用Chromeの操作を許可する」と回答した後、`%USERPROFILE%\.codex\config.toml`に登録し、Shikigamiの基本操作27ツールだけに個別の承認設定を適用しました。任意JavaScript実行、ファイルアップロード／ドロップ、ダイアログ応答はCodex側の公開対象から除外しました。他の設定が変わっていないことをTOMLの比較で確認し、変更前のバックアップも保存しています。

保存済み設定を読み込んだ実モデル（Codex CLI／gpt-6-luna）が、専用Chromeでローカル試験ページへの移動、フォーム入力、クリック、`記録済み：SHIKIGAMI-CODEX-OK`の表示確認、専用ブラウザ終了に成功しました。7回のMCP呼び出しが成功し、エラー0、検証判定`verified:true`です。記録：`artifacts/codex-integration.json`、`artifacts/codex-integration-events.jsonl`。モデル試験は既存Codexの利用枠を消費し、別のAPI契約は使用していません。

前回21:37のモデル試験は「MCP tool call requires approval, but approval policy is never」で停止しました。その失敗記録は`artifacts/codex-integration-blocked.json`に保持しています。今回の成功は、ユーザーが専用Chromeの操作を許可した後の結果です。

Codexデスクトップ版の既存チャットへ新しいツールが読み込まれるかは**未確認**です。アプリ全体の再起動、別セッションの停止、既存computer-useの操作先変更はしていません。普段使いはこのプロジェクトの新しいチャットからShikigamiを指定し、未読込ならMCP接続だけを再読込します。[公式OpenAIドキュメント](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

**ブラウザ専用版は自作可能で、このPCで基本動作を確認できました。** 推奨はChromeのheadless起動＋独立した一時プロファイル＋Playwright MCPです。専用サービスの月額料金、Windowsのアップグレード、管理者権限は今回不要でした。Windowsアプリ全般への拡張は別方式が必要で、今回実証した範囲には含めません。

以下の同時操作・メモリの詳細は、初回Edge測定の記録です。

## 今回、何を動かしたか

人間はCodex内の確認ページを操作し、その裏で**別プロセスの非表示Edge**がローカルの試験ページを3タブ開きました。AI側でフォーム入力・送信ボタンのクリック・スクロール・次ページへの移動を繰り返しました。OSのマウス操作を真似る方式ではなく、ブラウザに直接命令を送っています。

確認画面の表示はスクリーンショットの閲覧だけです。AIブラウザ自体のウィンドウは表示しません。今回の作業は固定の検証手順をMCPで実行したもので、モデルが毎回画面を判断する長時間の自律作業とは別です。

## 実機情報

| 項目 | 確認結果 |
|---|---|
| OS | Windows 11 **Home**、10.0.26300 |
| CPU | Ryzen 7 5700X、8コア／16論理プロセッサ |
| メモリ | 15.93GiB、初回空き1.79GiB。測定時の空きは変動 |
| GPU | NVIDIA GeForce RTX 4070 SUPER |
| Cドライブ | 容量951.60GiB、空き264.43GiB |
| ブラウザ | インストール済みEdge 154.0.4258.53を使用 |
| 権限 | 非管理者、対話セッション1で実行 |
| 仮想化 | Firmware enabled=true、HypervisorPresent=true、CIMのSLAT=false |
| 試作用ソフト | Node 24.16.0、Playwright MCP 0.0.83、MCP SDK 1.32.1 |

CIMのSLAT=falseだけでCPUの仮想化非対応とは判定しません。稼働中hypervisorの影響もあり、VM導入時に改めて確認が必要です。Homeのため標準Hyper-V／Windows Sandboxの対応エディション外という点とは分けます。[MicrosoftのHyper-V要件](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/reference/hyper-v-requirements)

## 実測結果

本測定：20:47:09〜20:48:23頃、73.5秒。人間側を自動入力する処理は実行していません。

| 検証内容 | 結果 | 判定 |
|---|---|---|
| 非表示のAIブラウザ | 3タブで5周。フォーム・スクロール・遷移45チェック成功 | **確認済み** |
| 複数タブ | 作成、選択、一覧、クローズ成功 | **確認済み** |
| 人間の操作との並行 | 入力1イベント、マウス移動323、クリック2、ホイール10。7つのMCP呼び出し区間と人間操作が重複 | **確認済み：基本操作** |
| 入力先への干渉 | 前面ウィンドウ変更0、AIが前面になった標本0／863 | **この測定で干渉を観測せず** |
| AI画面の割り込み | AIプロセスの可視トップレベルウィンドウ検出0／56 | **この測定で表示を観測せず** |
| マウスの干渉 | 人間がマウス操作を続けられ、本人が画面とチャットで「干渉なし」と回答 | **この試行で確認済み** |
| 必要時だけ画面確認 | MCP画像応答、確認ページの画像表示／非表示を実操作し、PC・モバイル幅を目視確認 | **確認済み** |
| MCP互換 | 独自stdioラッパー→公式Playwright MCPで31ツール発見、日本語入力、クリック、画像取得成功 | **確認済み：SDKクライアント試験** |
| Codexへの実配線（22:07追試） | グローバル登録を読み込んだ実モデルが専用Chromeを7回のMCP呼び出しで操作 | **確認済み：CLI。既存デスクトップチャットの読込は未確認** |
| 連続タイピング・IME | 入力イベントは1回。入力全文を保存していないため文字欠落比較なし | **未検証** |
| 別のネイティブアプリとの同時入力 | 人間側はCodex内の確認ページ。メモ帳等との同時入力テストは実施せず | **未検証** |
| AI側Windowsアプリ | 独立したWindowsセッション／VMを用意していない | **未検証** |

OS監視は50ms間隔を目標にしましたが、実測平均は85.1ms、最大間隔751msでした。メモリ取得中に間隔が延びます。瞬間的な割り込みを完全否定する観測ではありません。観測したカーソル位置変更372回は人間自身の動きを含むため、その回数をAIの干渉とみなしません。ページのblur2回も子要素から伝播するイベントを含み、OSの入力先変更とは同一ではありません。

### メモリ

- MCPサーバー＋専用EdgeのWorking Set合計：本測定ピーク **737.2MiB**（約0.72GiB）。3タブ作業中は主に約691〜737MiB。
- 同じプロセス群のPrivate Bytes：ピーク **483.4MiB**。
- ShikigamiのNodeプロセス：測定終了時RSS **69MiB**。上記と合わせた規模感は約0.8GiB。ただし同時点の厳密な総ピークではありません。
- ブラウザを起動する前のMCPプロセスだけでは約110MiB。計測PowerShell、人間の確認画面、既存Codex本体は上記AI側集計に含めません。

Working Setの合計には共有メモリの重複があり、Private Bytesはコミット量です。OS全体の消費増分と同一ではありません。外部サイト、動画、多数タブでは増える可能性があり、今回の軽いローカルページの値を一般化できません。GPUのVRAMを16GBのシステムRAMの代わりにはできません。

## 方式比較

| 方式 | 入力と表示の分離 | Windowsアプリ | 軽さ・費用・判定 |
|---|---|---|---|
| **headless Chrome＋Playwright MCP** | ブラウザの命令経路を使用。表示なしで操作・撮影できる | 対象外 | **推奨・実測済み**。人間の同時操作は初回Edgeで確認。追加月額なし |
| 通常表示の別ブラウザ／別プロファイル |Cookie等は分けられるが、ウィンドウ出現やOS入力の分離を保証しない | 対象外 | 軽いが今回の要件には不十分 |
| Windows標準の仮想デスクトップ | ウィンドウの整理・切替。独立した入力装置にはならない | 置けるが入力干渉は残る | **この方式だけでは実現困難** |
| Win32 `CreateDesktop` | 別desktopは作れるが、同一window stationのinput desktopは同時に1つ。隠れた側への汎用SendInputは成立しない | 対応方式・アプリ次第 | 軽量候補だが、非表示撮影・汎用操作は**未検証** |
| UI Automation／アプリ固有API | 対応コントロールを直接操作するならフォーカス不要にできる場合あり | 対応するアプリ／操作に限定 | 軽いが全アプリ対応の代替にはならない。**未検証** |
| 別ユーザー／RDPセッション | 標準Win11でホスト人間と別ユーザーの同時利用を当然視できない。HomeはRDPホスト対象外 | セッション内で可能でも同時利用条件が問題 | **今回の推奨外**。OS改変で制限解除しない |
| Windows Sandbox／Hyper-V | ゲスト内の操作をホスト入力から分けられる | ゲスト内のアプリ | Home対象外。OS変更、メモリ、ゲスト利用権の検討が必要 |
| VirtualBox／VMware Workstation | 別ゲスト内に操作エージェントを置くなら分離可能 | ゲスト内のアプリ | **全Windows対応の次候補・未検証**。現在の空きRAMでは重い |

`SendInput`は共通の入力ストリームへイベントを挿入します。隠れたデスクトップの汎用操作を実現したことにはなりません。PrintWindowも対象アプリ側の描画実装に依存します。[Win32 desktops](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)、[UI Automation patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview)

## Codexの既存computer-useとの違い

今回の接続は**独自MCPツールとして追加**するもので、既存computer-useの操作先を差し替えるものではありません。標準のWindows computer-useはSendInputやUI Automationを使用するため、単に別ウィンドウに移しただけで入力が分離されると扱えません。

ShikigamiではWeb本文の操作をPlaywright MCPに限定します。ブラウザのタブ／DOM／アクセシビリティ／画像は扱えますが、OSのメモ帳、認証画面、ネイティブダイアログを同じ道具では操作できません。ツールの選択を誤って既存computer-useを使えば、ホストの入力干渉が再発する可能性があります。[CodexのMCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)

ブラウザプロファイルは一時的で、普段のログイン状態を共有しません。今後ログインを維持する場合はAI専用の永続プロファイルを別途設計します。CAPTCHA、passkey／Windows Hello、管理者権限のUAC、DRM、拡張、音声・カメラ、ファイル選択・印刷ダイアログ、GPU依存UI、長時間動作、ロック・スリープ復帰は未検証です。外部サイトへの投稿・送信は今回行っていません。

## Windowsアプリ対応、権限・ライセンス・費用

- ブラウザ試作：現在はインストール済みChromeとローカルNodeで実行し、管理者権限を使いません。Playwright MCPはApache-2.0。専用の月額契約・APIキー・追加LLM API課金は不要です。モデル利用は既存Codexの枠を消費します。
- Windows Sandbox：Pro／Enterprise／Educationが対象、Home対象外。終了時に環境が破棄されるため永続作業にも制約があります。[Microsoft](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)
- VirtualBox：公式はWindows 11 x86_64ホスト対応を掲載。基本パッケージはGPLv3で無償。Extension Packは別ライセンスなので、必要機能と利用条件の確認が必要です。[対応ホスト](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/installation.html)、[ライセンス](https://www.oracle.com/virtualization/technologies/vm/downloads/virtualbox-downloads.html)
- VMware Workstation Pro：17.5.2以降は個人・教育・商用で無償と公式案内。Windows 11ホストは対応表にありますが、このHome Build26300での起動は未検証です。[Broadcomの利用条件](https://knowledge.broadcom.com/external/article/368667/download-and-license-information-for-vmw.html)、[対応ホスト](https://knowledge.broadcom.com/external/article/315653/supported-host-operating-systems-for-wor.html)
- ハイパーバイザが無料でも、WindowsゲストOSやゲスト内アプリの追加ライセンスが不要とは限りません。既存Windows Homeのライセンス形態を今回確認していないため、追加費用は算定していません。[Windows仮想化のライセンス資料](https://www.microsoft.com/licensing/docs/documents/download/Windows%2011%20licensing%20for%20Virtual%20Desktops.pdf)
- Windows 11ゲストの最低RAMは4GB、仮想ディスク64GB。実機のディスク空きはありますが、現在の空きRAMは約2GBなので、普段の作業と並行するWindows VMの常用は余裕が少ないと判断します。VM導入は管理者権限や再起動が必要になり得ます。32GBへの増設等は次段階の候補であり、今回のブラウザ版には不要です。[Windows 11 VM要件](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)

## 参考サービスとの関係

[Cua Spaces](https://spaces.cua.ai/)は閲覧時点でmacOS／Apple silicon向けの環境を案内しており、そのままこのWindows PCに導入する案ではありません。

[TwinDesktop](https://twindesktop.com/)はWindows用の並行デスクトップ、PiP、MCPを案内していますが、[公式ドキュメント](https://twindesktop.com/docs)ではHome非対応、初期設定に管理者権限が必要とされています。内部のセッション分離方式やWindowsライセンス適合性を独立検証したわけではなく、宣伝上の機能から同方式を再現できるとは断定しません。

## 推奨する次の範囲

Codexへの接続とローカルページ操作は成功したため、次は実際に使う2〜3サイトでログイン・長時間の連続操作・タブ整理を検証する段階です。タブ上限、終了処理、永続プロファイル、エラー回復を優先します。全Windowsアプリ対応は別フェーズとし、VMかアプリ固有APIが必要な作業だけを扱います。

成果物：`README.md`に起動・接続方法、`codex-config.example.toml`に接続設定、`artifacts/2026-10-06T11-47-06-201Z-report.json`に本測定、同名の`-raw.json`に標本データ、`artifacts/mcp-contract.json`にMCP試験結果、`artifacts/panel-*.png`に確認画面を保存しました。

後片付け：測定終了後に専用Edgeを閉じ、そのMCPプロセス配下にEdgeが残っていないことを確認しました。確認ページは結果閲覧用に残し、ツール無操作30分で試作サービスも自動終了します。`artifacts/cleanup.json`に記録しました。


公開準備時の変更：MCPサーバー本体も27ツールの明示的な許可リストに制限しました。任意コード実行、ページ内JavaScript実行、アップロード／ドロップ、ダイアログ応答をサーバー側でも非公開にしています。設定例は汎用パスと操作承認を求める設定に変更し、個人用の承認設定は配布しません。


## Windowsアルファ版への更新

初期の技術試作に加え、作業スペースUI、アプリとMCPで共有する専用Chrome、Codex設定のバックアップ付き登録、操作中の停止・待機命令の破棄・再開を実装しました。

- 2つのMCPクライアントによる同一ブラウザ参照、フォーム操作、画像、停止、再開、設定の保持を自動検証。成功。
- PC・モバイル幅の実画面、接続設定、プレビュー表示／非表示、停止・再開、診断、切断表示を実操作で検証。成功。人間の同時操作試験を自動入力で代行した結果ではありません。
- 新しい共有サービスにも実際のCodex CLIモデルを接続。7回のMCP呼び出しで移動・入力・クリック・結果検索・終了を確認。
- 同梱Nodeを使って配布物内の共有サービスを検証。成功。
- Windows用セットアップをコンパイルし、ランタイム込みのZIPを作成。個人用パス・トークン・生ログを除外。
- インストーラー実行は自動承認レビューから「blocked by policy」で拒否。詳細な理由は返されなかったため、導入・アンインストール・スタートメニュー起動は未確認です。実行経路を変える回避はしていません。

現在の画面表示は専用Chromeのアプリウィンドウを使います。Tauriは将来の候補で、今回の配布物には使っていません。新しいアプリ全体のメモリ、長時間運用、外部サイト、スリープ復帰は未測定・未検証です。
