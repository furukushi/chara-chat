// 表示文専用ファイル（設計書 v3.3）
//
// このアプリの画面に表示される静的な文章は、全てこのファイルに名前付きの
// 定数として集約する。画面側（App.tsx 等）はこのファイルだけを参照し、
// 文言を直接書かない。文言を変えたい時はこのファイルだけを編集すればよい。
//
// 対象外: キャラ名・発言本文・日付などの動的データそのもの、生成プロンプト、
// サーバ側で組み立てる通知文。動的な値を埋め込む文は、値を引数に取る
// 関数として置く（例: characterSettingsTitle）。
//
// 構成は画面・部品ごとに名前空間を分けてある。同じ文言が複数箇所で使われる
// 場合は common などへ寄せて一本化してある。

// 複数の名前空間にまたがって使う同一文言は、表記のずれを防ぐため定数へ
// 寄せて参照する。
const GENERATION_FAILED = "生成に失敗しました";
const IMPORT_DONE = "取り込みが完了しました。";
const IMPORT_FAILED = "取り込みに失敗しました。";
const GROUP_DELETE_DESC = "このグループと掛け合いログを全て削除します。元には戻せません";
const SCHEDULE_CREATE = "スケジュールを作成";
// レビューまわりで名前空間をまたいで使う同一文言（通常レビュー・設定全体
// レビュー・レビュー履歴・自動レビューの結果で共通）。
const REVIEW_REGISTERED =
  "レビューを登録しました。見直しが終わると設定へ自動で反映されます。結果はレビュー履歴で確認できます。";
const REVIEW_FAILED = "レビューの送信に失敗しました";
const REVIEW_REQUIRED = "指摘を入力してください。";
const REVIEW_SUBMIT = "レビューを送る";
const REVIEW_SENDING = "送信中…";
const REVIEW_NO_CHANGE_NOTE = "見直しの結果、設定の変更はありませんでした。";
const REVIEW_FAILED_NOTE_SUFFIX = "（設定は変更されていません）";
const REVIEW_INTENT_HEADING = "改訂の意図";
const REVIEW_DIFF_HEADING = (n: number) => `設定の差分（${n}件）`;
// グループ名の表示（スケジュール一覧と「自動」シートで共通）。
const GROUP_TARGET_NAME = (name: string) => `グループ「${name}」`;
// 「自動」の設定まわりの見出し（メニュー・シート・グループメニューで共通）。
const AUTO_TOPIC_SETTINGS = "自動の設定";

export const TEXTS = {
  // ------------------------------------------------------------ 共通
  common: {
    cancel: "キャンセル",
    close: "閉じる",
    save: "保存する",
    saving: "保存中…",
    loading: "読み込み中…",
    loadFailed: "読み込みに失敗しました。",
    reload: "再読み込み",
    delete: "削除",
    deleteConfirm: "削除する",
    deleteFailed: "削除に失敗しました",
    change: "変更する",
    edit: "編集",
    backToList: "一覧へ戻る",
    saveFailed: "保存に失敗しました",
    changeFailed: "変更に失敗しました",
    selected: "選択中",
    all: "すべて",
    uncategorized: "未分類",
    category: "カテゴリ",
    memberCount: (n: number) => `${n}人`,
    selectedCount: (n: number) => `選択中 ${n}人`,
    categoryEmpty: "このカテゴリのキャラクターはいません。",
    noCategoriesYet:
      "まだカテゴリが登録されていません。一覧の「その他」メニューの「カテゴリ管理」から先にカテゴリを追加してください。",
    categoryAria: (name: string) => `カテゴリ「${name}」`,
    categoryFilterGroupAria: "カテゴリの選択（複数選択可）",
  },

  // ------------------------------------------------------------ 失敗通知（setFailureNoticeText）
  notice: {
    inputCheck: "入力内容を確認してください。",
    genericFailure: "うまくいきませんでした。もう一度お試しください。",
  },

  // ------------------------------------------------------------ 生成の失敗理由
  failReasons: {
    timeout: "タイムアウト（10分以内に生成が終わりませんでした）",
    pendingTimeout: "返信の生成が始まらないまま時間切れになりました。時間をおいて再度お試しください",
    rateLimited: "Claudeの利用上限に達しました。時間をおいて再度お試しください",
    authError: "生成に使うClaudeのログインセッションが切れています。再ログインすると直ります",
    generationError: GENERATION_FAILED,
    fallback: GENERATION_FAILED,
    withDetail: (reason: string) => `生成に失敗しました（${reason}）`,
  },

  // ------------------------------------------------------------ 経過時間の表記
  elapsed: {
    seconds: (n: number) => `${n}秒`,
    minutes: (n: number) => `${n}分`,
    hoursMinutes: (h: number, m: number) => `${h}時間${m}分`,
  },

  // ------------------------------------------------------------ 一覧の状態バッジ
  status: {
    pending: "返信待ち",
    reviewing: "レビュー中",
    processing: "生成中",
    failed: "失敗",
    unreplied: (n: number) => `未返信 ${n}`,
  },

  // ------------------------------------------------------------ 返信リクエストのバナー
  requestBanner: {
    replyWord: "返信",
    groupWord: "掛け合い",
    failedSuffix: "。送った文章は入力欄に戻してあります。",
    generating: (word: string, elapsed: string) => `${word}を生成中です…（${elapsed}経過）`,
    reviewing: (elapsed: string) => `自動レビュー中です…（${elapsed}経過）`,
    waiting: (word: string, elapsed: string) =>
      `${word}待ちです（発言から${elapsed}）。生成には数分かかることがあります。`,
  },

  // ------------------------------------------------------------ 区切り表示
  divider: {
    newMessages: "新着",
    newMessagesAria: "ここから新着の返信です",
  },

  // ------------------------------------------------------------ 区間（履歴の区切り・フレーム表示）
  segment: {
    bandAria: (date: string | null) =>
      date
        ? `ここからは過去の履歴を参照せずに生成された会話です（この区間の最初の生成は${date}）`
        : "ここからは過去の履歴を参照せずに生成された会話です",
  },

  // ------------------------------------------------------------ 戻し下書きの復元通知
  draftRestore: {
    failedNotice: (label: string) =>
      `返信に失敗しました（${label}）。文章を入力欄に戻しました。そのまま、または直して再送信できます。`,
  },

  // ------------------------------------------------------------ 全文出力シート
  exportSheet: {
    closeAria: "全文出力を閉じる",
    description:
      "このチャットの全履歴を「発言者名:内容」の形で時系列順に並べたプレーンテキストです。",
    textLabel: "チャット全文",
    copyFailed:
      "コピーできませんでした。上のテキストを長押し（または全選択）してコピーしてください。",
    copy: "全文をコピー",
    copied: "コピーしました",
    chatTitle: (name: string) => `${name}とのチャット全文`,
    groupTitle: (name: string) => `グループ「${name}」の全文`,
  },

  // ------------------------------------------------------------ 画像変更シート
  imageEdit: {
    title: (name: string) => `${name}の画像を変更`,
    description:
      "画像ファイルを選んで正方形にトリミングして保存すると、一覧・チャット・グループの表示にすぐ反映されます。",
    fileInputAria: "画像ファイルを選ぶ",
    chooseFile: "画像ファイルを選ぶ",
    chooseAnother: "別の画像を選ぶ",
    cropAreaAria: "トリミング範囲。ドラッグで位置を調整できます",
    croppingAlt: "トリミング中の画像",
    zoom: "拡大・縮小",
    previewNote: "プレビューは上の枠の通りです。ドラッグで位置を調整できます。",
    currentAlt: (name: string) => `${name}の現在の画像`,
    currentNote: "現在の画像です。新しい画像を選ぶと差し替わります。",
    saveCropped: "トリミングして保存",
    notImageFile: "画像ファイルを選んでください。",
    loadImageFailed: "画像を読み込めませんでした。別のファイルをお試しください。",
    processFailed: "画像の処理に失敗しました。",
  },

  // ------------------------------------------------------------ キャラ設定メニュー
  characterMenu: {
    menuAria: (name: string) => `${name}の設定メニュー`,
    title: (name: string) => `${name}の設定`,
    editSettings: "設定を編集する",
    editSettingsDesc: "概要の確認と、項目ごとの入力欄での設定の書き換えをします",
    editImage: "画像を変更",
    editImageDesc: "画像を選んでトリミングして差し替えます",
    rename: "表示名を変更",
    renameDesc: "表示される名前だけを変えます",
    setCategory: "カテゴリを設定",
    setCategoryDesc: "カテゴリを選んで分類します（複数選択可）",
    deleteCharacter: "キャラを削除する",
    deleteCharacterDesc: "このキャラクターと会話ログを削除します。元には戻せません",
  },

  // ------------------------------------------------------------ キャラ設定の閲覧シート
  characterSettings: {
    displayName: "表示名",
    originalName: "元の名前",
    sourceProfileId: "取り込み元ID",
    createdAt: "登録日時",
    settingsTextHeading: "設定本文（生成に使われる内容）",
    relationTextHeading: "関係・呼び方",
    footerNote:
      "発言への指摘はチャット画面のレビューモードから行えます。",
    reviewHeading: "設定全体へのレビュー",
    reviewDesc:
      "特定の発言ではなく、このキャラクターの設定全体に対する指摘を送れます。送信すると、AIが設定全体を見直して自動で適用します。結果と差分はレビュー履歴に残り、履歴から取り消せます。",
    reviewLabel: "設定全体への指摘",
    reviewPlaceholder: "例: 一人称は「オレ様」のはずが、設定の話し方では「ボク」になっている",
    reviewRequired: REVIEW_REQUIRED,
    reviewSubmit: REVIEW_SUBMIT,
    reviewSending: REVIEW_SENDING,
    reviewRegistered: REVIEW_REGISTERED,
    reviewFailed: REVIEW_FAILED,
    reviewOpenHistory: "レビュー履歴を見る",
  },

  // ------------------------------------------------------------ 設定の編集フォーム
  settingsEdit: {
    sheetAria: (name: string) => `${name}の設定を編集する`,
    title: "設定を編集する",
    notEditable:
      "このキャラクターは設定データ（avatar-profile形式）を保持していないため、ここからは編集できません。",
    intro:
      "保存すると、このアプリ内の設定が書き換わり、次の返信から反映されます（アバター管理ツール側の設定と表示名は変わりません）。",
    sectionOverview: "概要",
    overviewNote:
      "生成に使われる設定本文と関係・呼び方は、上の項目を保存すると自動で組み直されます。",
    showOutput: "出力を確認する",
    hideOutput: "出力を閉じる",
    advancedButton: "詳細設定",
    advancedTitle: "詳細設定",
    advancedAria: (name: string) => `${name}の詳細設定`,
    advancedBack: "設定の編集に戻る",
    advancedIntro:
      "レビューに関する設定です。ここでの変更は、この画面でそのまま保存されます。",
    nameRequired: "名前を入力してください。",
    sectionBasic: "基本",
    sectionBackground: "背景",
    sectionSpeech: "話し方",
    sectionRelation: "相手との関係",
    sectionAppearance: "見た目の要素",
    sectionTraits: "フレーバー特性",
    labelName: "名前",
    labelSummary: "概要",
    labelGreeting: "挨拶の例",
    labelAvatarMemory: "固有の記憶",
    labelBackgroundText: "背景（本文）",
    labelLinks: "関連リンク",
    labelLinkSummary: "つながりの要約",
    labelPortrayalFocus: "演じる姿・状況",
    labelVideoUrls: "参考動画URL",
    labelSpeechStyle: "話し方の説明",
    labelFirstPerson: "一人称",
    labelSecondPerson: "二人称",
    labelCatchphrase: "口癖",
    labelSpeechMemo: "話し方のメモ",
    labelVideoNotes: "口調の参考資料（参考動画の所見）",
    labelUserRelationship: "相手との関係",
    labelCallUserAs: "相手の呼び方",
    hintOnePerLine: "1行に1件ずつ入力してください。",
    hintPortrayalFocus: "このキャラクターを演じる前提の姿・状況です。空欄なら指定なしです。",
    hintVideoNotes:
      "参考動画の台詞から得た口調の所見です。参考資料であり、台詞や言い回しの正本ではありません。",
    elementKeyAria: (i: number) => `見た目の要素${i + 1}の項目名`,
    elementValueAria: (i: number) => `見た目の要素${i + 1}の内容`,
    elementDeleteAria: (i: number) => `見た目の要素${i + 1}を削除`,
    elementKeyPlaceholder: "項目名（例: 髪）",
    elementValuePlaceholder: "内容",
    addElement: "＋ 要素を追加",
    traitNameAria: (i: number) => `フレーバー特性${i + 1}の名前`,
    traitDeleteAria: (i: number) => `フレーバー特性${i + 1}を削除`,
    traitNamePlaceholder: "特性の名前",
    traitExamplesLabel: "例（1行に1件）",
    traitEnabled: "この特性を有効にする",
    addTrait: "＋ 特性を追加",
  },

  // ------------------------------------------------------------ 表示名の変更シート
  renameCharacter: {
    title: "表示名を変更",
    description: "一覧やチャットで表示される名前だけを変えます（設定や会話履歴には影響しません）。",
    label: "表示名",
    nameRequired: "表示名を入力してください。",
  },

  // ------------------------------------------------------------ カテゴリ管理シート
  categoryManage: {
    title: "カテゴリ管理",
    closeAria: "カテゴリ管理を閉じる",
    description:
      "カテゴリはキャラ一覧の絞り込みに使います。親カテゴリを設定して子カテゴリを作れ、親で絞り込むと子・孫のキャラもまとめて表示されます。\n1キャラに複数のカテゴリを設定でき、各キャラへの割り当てはキャラの設定メニュー「カテゴリを設定」から行います。",
    newNameLabel: "新しいカテゴリ名",
    namePlaceholder: "例: ゲーム",
    parentLabel: "親カテゴリ",
    topLevelOption: "最上位（親なし）",
    add: "追加",
    adding: "追加中…",
    empty: "まだカテゴリがありません。",
    nameLabel: "カテゴリ名",
    parentNote: "自分自身と自分の子カテゴリは親に選べません。",
    parentDisplay: (name: string | null) => (name != null ? `親: ${name}` : "最上位"),
    unknownParent: "（不明）",
    deleteConfirmPrefix: "削除しますか？",
    deleteChildMoveNote: (dest: string) => `子カテゴリは${dest}の下へ移動します。`,
    deleteDestTop: "最上位",
    deleteDestNamed: (name: string) => `「${name}」`,
    cancelDelete: "やめる",
    editAria: (name: string) => `カテゴリ「${name}」を編集`,
    deleteAria: (name: string) => `カテゴリ「${name}」を削除`,
    nameRequired: "カテゴリ名を入力してください。",
    addFailed: "追加に失敗しました",
  },

  // ------------------------------------------------------------ カテゴリ割り当てシート
  categoryAssign: {
    sheetAria: (name: string) => `${name}のカテゴリを設定`,
    title: (name: string) => `${name}のカテゴリ`,
    description:
      "複数のカテゴリを選べます。複数に登録したキャラは、どのカテゴリで絞り込んでも表示されます。子カテゴリに登録したキャラは、その親カテゴリで絞り込んだ時にも表示されます。ただし、子カテゴリとその親カテゴリは同時には選べません（子を選ぶと親は自動で外れます）。何も選ばなければ未分類になります。",
    blockedByChild: (name: string) => `子カテゴリ「${name}」を選択中のため選べません`,
    currentlyUncategorized: "現在は未分類です（カテゴリ未選択）。",
    setFailed: "設定に失敗しました",
  },

  // ------------------------------------------------------------ 一括取り込みのステータス（ローカル改善4の復元）
  importStatus: {
    running: "取り込み中…",
    runningBanner: (elapsed: string) =>
      elapsed ? `アバター管理から一括取り込み中です…（${elapsed}経過）` : "アバター管理から一括取り込み中です…",
    runningNote: "取り込み中です。完了するまでしばらくお待ちください。このシートを閉じても取り込みは続きます。",
    doneBanner: (note: string) => (note ? `${IMPORT_DONE}${note}` : IMPORT_DONE),
    failedBanner: (note: string) => (note ? `${IMPORT_FAILED}${note}` : IMPORT_FAILED),
    doneNote: (note: string) => (note ? note : IMPORT_DONE),
    failedNote: (note: string) => (note ? note : IMPORT_FAILED),
    dismissAria: "取り込み結果の表示を閉じる",
  },

  // ------------------------------------------------------------ レビュー
  review: {
    statusLabels: {
      pending: "処理待ち",
      processing: "見直し中",
      done: "完了（自動適用済み）",
      no_change: "変更なし",
      failed: "失敗",
    } as Record<string, string>,
    failReasons: {
      timeout: "タイムアウト（10分以内に見直しが終わりませんでした）",
      pending_timeout: "見直しが始まらないまま時間切れになりました",
      auth_error: "生成に使うClaudeのログインセッションが切れています。再ログインすると直ります",
      rate_limited: "Claudeの利用上限に達しました",
      generation_error: "生成に失敗しました",
      invalid_json: "見直し結果がJSONとして読み取れませんでした",
      invalid_format: "見直し結果の形式が avatar-profile ではありませんでした",
      name_mismatch: "見直し結果のキャラクター名が対象と一致しませんでした",
      id_mismatch: "見直し結果のプロファイルIDが元のものと変わっていました",
      invalid_profile: "見直し結果から設定を構築できませんでした",
      no_source_json: "元の設定JSONが保持されていないため、見直しできませんでした",
      character_not_found: "キャラクターが見つかりませんでした",
    } as Record<string, string>,
    failFallback: "見直しに失敗しました",
    failWithDetail: (reason: string) => `見直しに失敗しました（${reason}）`,
    modeToggle: (active: boolean) => (active ? "レビューモード ON" : "レビューモード"),
    panelAria: "レビューの指摘を書く",
    targetLabel: (speakerName: string) => `レビュー対象（${speakerName}の発言）`,
    cancelSelectionAria: "レビューの選択をやめる",
    feedbackLabel: "設定と異なっている点",
    feedbackPlaceholder: "例: 一人称は「オレ様」のはずが「ボク」になっている",
    feedbackRequired: REVIEW_REQUIRED,
    sending: REVIEW_SENDING,
    submit: REVIEW_SUBMIT,
    openHistoryForChar: "このキャラのレビュー履歴",
    panelNote:
      "送信すると、AIがキャラ設定を見直して自動で適用します。結果と差分、改訂の意図はレビュー履歴に残ります。",
    selectMessageAria: (excerpt: string) => `この発言をレビュー対象に選ぶ: ${excerpt}`,
    registeredNotice: REVIEW_REGISTERED,
    submitFailed: REVIEW_FAILED,
    reviewModeNote: "レビューモードが有効です。メッセージ生成前にレビューを開始します。",
    reviewModeSaveFailed: "レビューモードの切り替えを保存できませんでした。表示を元の状態に戻しました。",
    chatBanner: "レビューモード中です。キャラの発言をタップして選ぶと、設定と違う点を指摘できます。",
    groupBanner:
      "レビューモード中です。キャラの発言をタップして選ぶと、そのキャラの設定への指摘ができます。",
    historyButton: "レビュー履歴",
  },

  // ------------------------------------------------------------ レビュー履歴シート
  reviewHistory: {
    title: (name: string) => `${name}のレビュー履歴`,
    closeAria: "レビュー履歴を閉じる",
    description:
      "指摘を受けてAIが見直した結果です。各見直しには、改訂の意図（何を狙ってどう変えたか）もあわせて残ります。差分があった見直しは自動で設定に適用されています。適用済みの改訂は、変更前の設定へ取り消せます。",
    empty:
      "まだレビューはありません。レビューモードでキャラの発言を選んで指摘を送るか、「設定を編集する」画面から設定全体へのレビューを送ると、ここに記録されます。",
    revertFailed: "取り消しに失敗しました",
    articleAria: (date: string) => `レビュー ${date}`,
    revertedBadge: "取り消し済み",
    autoBadge: "自動",
    groupMessage: "グループでの発言",
    chatMessage: "1対1での発言",
    settingsMessage: "設定全体へのレビュー",
    targetHeading: "対象の発言",
    autoTargetHeading: "今回の利用者のメッセージ",
    autoFeedbackHeading: "自動レビューの方針",
    settingsTargetBody: "（特定の発言ではなく、設定全体へのレビューです）",
    feedbackHeading: "指摘",
    intentHeading: REVIEW_INTENT_HEADING,
    failedNoteSuffix: REVIEW_FAILED_NOTE_SUFFIX,
    failDetailLabel: (detail: string) => `詳細: ${detail}`,
    noChangeNote: REVIEW_NO_CHANGE_NOTE,
    diffHeading: REVIEW_DIFF_HEADING,
    diffEmpty: "（なし）",
    diffDeleted: "（削除）",
    diffBefore: "変更前: ",
    diffAfter: "変更後: ",
    diffChangedPart: "変わった部分",
    diffFullSummary: "変更前・変更後の全文",
    beforeJsonSummary: "変更前の設定JSON全文",
    fullJsonSummary: "再出力された設定JSON全文（変更後）",
    copyJson: "JSONをコピー",
    copied: "コピーしました",
    revertConfirm:
      "この改訂を取り消して、変更前の設定に戻しますか？（この改訂より後の見直しも上書きされます）",
    revertCancel: "やめる",
    revertDo: "取り消す",
    revertButton: "この改訂を取り消す",
    revertedNote: (date: string) => `${date} に取り消され、変更前の設定に戻っています。`,
  },

  // ------------------------------------------------------------ 自動レビューの結果（会話画面）
  autoReview: {
    resultButton: "レビュー結果",
    resultButtonAria: "この回の自動レビューの結果を見る",
    resultTitle: "自動レビューの結果",
    closeAria: "自動レビューの結果を閉じる",
    statusLabels: {
      pending: "実行待ち",
      processing: "実行中",
      done: "変更あり",
      no_change: "変更なし",
      failed: "失敗",
    } as Record<string, string>,
    waitingNote: "まだ見直しが終わっていません。終わると結果がここに表示されます。",
    noChangeNote: REVIEW_NO_CHANGE_NOTE,
    failedNoteSuffix: REVIEW_FAILED_NOTE_SUFFIX,
    intentHeading: REVIEW_INTENT_HEADING,
    diffHeading: REVIEW_DIFF_HEADING,
    revertedNote: "この改訂はレビュー履歴から取り消されています。",
    historyHint: "差分の詳細と取り消しは、各キャラのレビュー履歴から行えます。",
  },

  // ------------------------------------------------------------ ホーム（一覧）
  home: {
    tabListAria: "チャットの種類",
    tabPersonal: "個人",
    tabGroup: "グループ",
    charactersSectionAria: "個人チャット",
    charactersHeading: "個人チャット",
    addCharacter: "キャラを追加",
    other: "その他",
    otherMenuAria: "その他のメニュー",
    otherMenuTitle: "その他",
    exportCharacters: "キャラ情報を出力",
    exportCharactersDesc: "キャラクターを選んで、設定JSON（画像つきも可）をファイルに書き出します",
    categoryManageDesc: "カテゴリの追加・名前変更・削除と、親子関係の設定をします",
    sortLabel: "並び替え",
    searchLabel: "キャラ名で検索",
    searchPlaceholder: "キャラ名で検索",
    searchEmpty: "検索に一致するキャラクターはいません。",
    sortAdded: "追加順",
    sortGojuon: "五十音順",
    sortRecent: "最近使用した順",
    compactToggle: (on: boolean) => (on ? "簡易表示 ON" : "簡易表示"),
    openChatAria: (name: string, unread: number) =>
      `${name}とのチャットを開く${unread > 0 ? `（未読の返信${unread}件）` : ""}`,
    settingsAria: (name: string) => `${name}の設定`,
    noCharacters:
      "まだキャラクターがいません。アバター総合管理のプロファイルを取り込むか、書き出しJSONを貼って追加できます。",
    bulkImport: "アバター管理から一括取り込み",
    importStarted:
      "取り込みを開始しました。反映まで少し時間がかかります。この画面は自動で更新されます。",
    importStartedShort: "取り込みを開始しました。反映まで少し時間がかかります。",
    addByJson: "書き出しJSONで追加",
    categoryFilterEmpty:
      "このカテゴリのキャラクターはいません。キャラの設定メニュー「カテゴリを設定」から分類できます。",
    groupsSectionAria: "グループチャット",
    groupsHeading: "グループチャット",
    createGroup: "グループを作る",
    randomCreateNow: "今すぐランダム作成",
    randomCreating: "作成中…",
    randomCreateNowDesc: "押した瞬間に、ランダムな顔ぶれで作ります",
    randomCreateBySchedule: "スケジュールで自動作成",
    randomCreateByScheduleDesc: "決めた時刻に、自動で作り続けます",
    randomCreateNeedChars: (n: number) =>
      `グループを自動作成するにはキャラクターが3人以上必要です（現在${n}人）。キャラを追加してください。`,
    groupCreateFailed: "グループの作成に失敗しました",
    noGroups:
      "キャラ同士の掛け合いを楽しむグループは、まだありません。1人から作れて、なりきり機能で自分も参加できます。",
    openGroupAria: (name: string, unread: number) =>
      `グループ「${name}」を開く${unread > 0 ? `（未読の返信${unread}件）` : ""}`,
    groupMenuAria: (name: string) => `グループ「${name}」のメニュー`,
    groupMenuTitle: (name: string) => `グループ「${name}」`,
    groupDelete: "削除",
    groupDeleteDesc: GROUP_DELETE_DESC,
    groupDeleteFailed: "グループの削除に失敗しました",
    groupDissolved: "解散済み（ログの閲覧のみ）",
    prevPage: "前のページ",
    nextPage: "次のページ",
    pageIndicator: (page: number, count: number, total: number) =>
      `${page} / ${count} ページ（全${total}件）`,
    footerNote:
      "発言を送ると、全体設定で選んだAIが自動で返信を書きます（数分かかることがあります）。返信に失敗した時は、送った文章が入力欄に戻るので、そのまま再送信できます。生成に渡される履歴は直近20発言までで、それより前の会話は参照されません。会話ログはこのアプリ内に保存されます。外部へのバックアップは無いため、アプリを削除するとログも消えます。",
    globalSettingsAria: "全体設定",
    globalSettingsHeading: "全体設定",
    notifyReply: "返信が届いたらMuseに通知する",
    notifyReplyDesc:
      "ONにすると、キャラからの返信（スケジューリングの自動生成も含む）が届いた時に、Muse側へメッセージが送られます。なお、Claudeのログイン切れ（トークン切れ）で生成に失敗した場合は、この設定がOFFでも通知されます。",
    replyEngine: "返信を考えるAI",
    replyEngineDesc:
      "すべてのチャット・グループの返信生成に使うAIです。レビューの見直しと「自動」の議題作成には影響しません。使ったAIは履歴（全体ログ）の生成記録の見出しに残ります。",
    engineClaude: "Claude",
    engineMuse: "Muse",
    claudeModel: "Claudeのモデル",
    claudeModelAuto: "自動（auto）",
    claudeModelSonnet: "Sonnet",
    claudeModelOpus: "Opus",
    claudeModelHaiku: "Haiku",
    engineClaudeCaution:
      "Claudeの注意点: 生成にはClaude（Claude Code）の契約とログインが必要です。ログインが切れると返信が作れなくなります（その場合は通知が届きます）。その代わり、生成はあなたの普段の会話とは完全に切り離されたヘッドレス実行で行われるため、普段の会話の記憶や人格がキャラの返信に混ざることはありません。キャラ設定と会話履歴だけを材料に、専用の生成プロセスが返信を作ります。",
    engineMuseCaution:
      "Museの注意点: 返信は、返信の見張りと受け渡しを担っている実行側のClaude（Muse）が、そのまま自分で考えて代入します。実行側は生成専用ではなく見張り・仲介の作業と兼務で、長い材料はエージェント側で要約・圧縮されて渡ることもあるため、専用の生成プロセスで作るClaudeより、キャラの口調や設定の再現精度が落ちることがあります。また、実行側のモデルは実行環境で固定されていて、このアプリからは選べません。",
    globalSettingsSaveFailed: "設定の保存に失敗しました。もう一度お試しください。",
    logsLink: "履歴（全体ログ）",
    deleteCharacterTitle: (name: string) => `${name}を削除しますか？`,
    deleteCharacterBody:
      "このキャラクターとの会話ログも一緒に削除されます。参加しているグループからは除外され、過去の発言は名前を残して保持されます。",
  },

  // ------------------------------------------------------------ スケジューリング
  schedule: {
    weekdayLabels: ["日", "月", "火", "水", "木", "金", "土"],
    freqDaily: "毎日",
    freqWeekly: (days: string) => `毎週 ${days}`,
    targetExisting: GROUP_TARGET_NAME,
    targetMissing: "（対象グループなし）",
    targetNew: "毎回新規チャット",
    drawFromCategories: (min: number, max: number) => `カテゴリから${min}〜${max}人を抽選`,
    drawFromAll: (min: number, max: number) => `全キャラから${min}〜${max}人を抽選`,
    guestsOn: "ゲストあり",
    mobsOn: "モブあり",
    narrationOn: "ナレーションあり",
    topicStartOn: "冒頭に議題を自動投稿",
    sectionAria: "スケジューリング",
    heading: "スケジューリング",
    create: SCHEDULE_CREATE,
    description:
      "決まった時刻になると、対象のグループチャットでキャラクター同士の会話を自動で生成します。スケジュールは複数作れます。",
    loadFailed: "スケジュールの読み込みに失敗しました。",
    empty: "まだスケジュールがありません。「スケジュールを作成」から追加できます。",
    enabledAria: (name: string) => `スケジュール「${name}」の有効・無効`,
    enabled: "有効",
    disabled: "無効",
    toggleFailed: "切り替えに失敗しました",
    deleteTitle: (name: string) => `スケジュール「${name}」を削除しますか？`,
    deleteBody: "このスケジュールでの自動生成は止まります。作成済みのグループや会話履歴は残ります。",
  },

  // ------------------------------------------------------------ スケジュール作成・編集シート
  scheduleEdit: {
    titleEdit: "スケジュールを編集",
    titleCreate: SCHEDULE_CREATE,
    nameLabel: "スケジュール名（必須）",
    namePlaceholder: "例: 朝の雑談",
    enableLabel: "このスケジュールを有効にする",
    frequencyHeading: "生成スケジュール",
    frequencyAria: "頻度",
    freqDaily: "毎日",
    freqWeekly: "毎週",
    weekdaysAria: "曜日（複数選択可）",
    weekdayAria: (label: string) => `曜日: ${label}`,
    timesHeading: "生成時刻（複数選択可・日本時間）",
    timeAria: (i: number) => `生成時刻${i + 1}`,
    timeDeleteAria: (i: number) => `生成時刻${i + 1}を削除`,
    addTime: "＋ 時刻を追加",
    targetHeading: "対象",
    targetTypeAria: "対象の種類",
    targetExistingLabel: "既存のグループチャット",
    targetExistingDesc:
      "選んだグループの設定（参加者・ゲスト/モブ・ナレーション・フレーバー）を使って、その中で会話を生成します",
    targetNewLabel: "毎回新規チャット",
    targetNewDesc: "実行のたびに新しいグループを作り、カテゴリから抽選したキャラで会話を生成します",
    targetGroupLabel: "対象のグループチャット",
    targetGroupPlaceholder: "選んでください",
    targetGroupNote:
      "なりきり設定が有効なグループは対象にできません。フレーバーはグループ側の設定を使います。",
    targetGroupUnavailable: (name: string) => `${name}（現在は対象に選べません）`,
    unknownGroup: "（不明なグループ）",
    drawCategoriesHeading: "抽選するカテゴリ（複数選択可・任意）",
    drawCategoriesNote:
      "指定なし＝全キャラが対象です。カテゴリを選んだ場合は、そのカテゴリ（子カテゴリを含む）に属するキャラクターの中から抽選します。",
    noCategorySelected: "指定なし＝全キャラが対象です",
    membersLabel: "人数",
    minMembersAria: "人数の最小",
    maxMembersAria: "人数の最大",
    autoTopicStartLabel: "冒頭に議題を自動投稿",
    autoTopicStartNote:
      "オンにすると、発火したとき通常の冒頭生成の代わりに、会話の冒頭で「自動」ボタンが押されたときと同じ処理を行います。議題を生成して投稿し、そこから掛け合いが始まります。",
    guestMobNarrationHeading: "ゲスト・モブ・ナレーション（作成されるグループに引き継がれます）",
    flavorsHeading: "フレーバー（作成されるグループに引き継がれます）",
    flavorsNote:
      "ここで指定したフレーバー一式が正で、作成されるグループへそのまま引き継がれます（グループ側で変えても、こちらには戻りません）。",
    nameRequired: "スケジュール名を入力してください。",
    timeRequired: "生成時刻を1つ以上入れてください。",
    weekdayRequired: "曜日を1つ以上選んでください。",
    targetGroupRequired: "対象のグループチャットを選んでください。",
    membersRangeError: "人数の最小は最大以下にしてください。",
    create: "作成する",
  },

  // ------------------------------------------------------------ 全体ログ
  logs: {
    kindLabels: {
      user_send: "送信",
      generation: "生成",
      review: "レビュー",
      settings: "設定変更",
      auto: "自動生成",
    } as Record<string, string>,
    bodyLoadFailed: "本文の読み込みに失敗しました。",
    bodyEmpty: "（本文なし）",
    requestHeading: "リクエスト（AIへ送った内容）",
    responseHeading: "レスポンス（AIから貰った返信）",
    filterGroupAria: "ログの種別で絞り込む",
    filterAll: "すべて",
    filterAria: (label: string) => `「${label}」のログだけ表示`,
    title: "履歴（全体ログ）",
    description:
      "あなたの送信、生成に使ったプロンプトと生レスポンス、レビュー、キャラクター設定の変更、自動生成の記録です。新しい順に最大100件まで残ります（古い物から消えます）。見出しをタップすると本文を開きます。上のボタンで種別ごとに絞り込めます。",
    empty:
      "まだログがありません。チャットで送信したり、設定を変更したりすると、ここに記録されます。",
    emptyForKind: (label: string) => `「${label}」のログはまだありません。`,
    toggleAria: (title: string, open: boolean) => `ログ「${title}」の本文を${open ? "閉じる" : "開く"}`,
    exportButton: "全てのログをファイルでダウンロード",
    exportFailed: "ログファイルの作成に失敗しました",
    exportHeading: (count: number, when: string) => `全体ログ（全${count}件、${when} 時点）`,
  },

  // ------------------------------------------------------------ キャラ取り込みシート
  importSheet: {
    title: "キャラクターを追加",
    description:
      "書き出しJSONを貼るか、端末の .json ファイルを選ぶとキャラクターを追加できます。複数人分が入ったファイルもそのまま取り込めます。",
    jsonLabel: "書き出しJSON",
    addedNotice: (name: string) => `「${name}」を追加しました。`,
    updatedNotice: (name: string) =>
      `「${name}」の設定を更新しました（会話履歴は保持されています）。`,
    importFailed: "取り込みに失敗しました",
    jsonRequired: "JSONを貼ってください。",
    importButton: "取り込む",
    fileButton: "ファイルから選ぶ（.json）",
    fileImporting: "ファイルを取り込んでいます…",
    fileReadFailed: "ファイルを読み取れませんでした。",
    fileNoCharacters: "ファイルに取り込めるキャラクターが含まれていません。",
    multiDone: (added: number, updated: number) =>
      `ファイルから取り込みました（追加 ${added}件・更新 ${updated}件）。`,
    multiPartial: (added: number, updated: number, failedNames: string[]) =>
      `追加 ${added}件・更新 ${updated}件を取り込みましたが、${failedNames.length}件は取り込めませんでした（${failedNames.join("、")}）。`,
    bulkImportWithImages: "アバター管理から一括取り込み（画像つき）",
    createNewButton: "一から作成する",
  },

  // ------------------------------------------------------------ キャラ新規作成シート
  createCharacter: {
    title: "キャラクターを作成",
    sheetAria: "キャラクターを一から作成する",
    intro:
      "名前だけ必須で、他の項目は空でも作成できます。作成したキャラクターは、取り込んだキャラクターと同じようにチャット・カテゴリ・レビューの対象になり、キャラ情報の出力でJSONも書き出せます。",
    submit: "作成する",
    submitting: "作成中…",
  },

  // ------------------------------------------------------------ キャラ情報の出力シート
  characterExport: {
    title: "キャラ情報を出力",
    description:
      "選んだキャラクターの設定JSONを書き出します。1人だけの場合は character.json ファイルとして、その他の場合は「キャラ名」フォルダに character.json を入れた zip として出力します。",
    selectAll: "全て選択",
    clearAll: "選択を解除",
    includeImages: "画像も書き出す",
    includeImagesDesc:
      "オンにすると、各キャラクターのフォルダに character.json とキャラ画像ファイルが入ります。",
    noImageNote: "（画像なし）",
    selectRequired: "キャラクターを1人以上選んでください。",
    failed: "出力に失敗しました",
    preparing: "出力中…",
    exportButton: (n: number) => (n > 0 ? `${n}人を出力する` : "出力する"),
    selectAria: (name: string) => `${name}を出力対象にする`,
  },

  // ------------------------------------------------------------ グループ作成シート
  createGroup: {
    title: "グループを作る",
    nameLabel: "グループ名（任意）",
    namePlaceholder: "空欄なら参加キャラ名から自動で付けます",
    autoTitleLabel: "名前はおまかせ",
    autoTitleDesc:
      "オンにすると、返信が生成されるたびに、その掛け合いの内容を要約したタイトルがグループ名に代入されます（入力した名前は最初の名前として使われます）。",
    membersHeading: "参加キャラクター（1〜8人）",
    membersNote:
      "1人だけでも作れます。作成後に「なりきり」を設定すると、自分がそのキャラとして参加できます。",
    joinAria: (name: string) => `${name}を参加させる`,
    guestMobNarrationHeading: "ゲスト・モブ・ナレーション",
    guestMobNarrationNote:
      "オンにすると、会話の流れに応じて参加者以外が混じることがあります（混じらないこともあります）。作成後もグループの設定から変えられます。",
    guestLabel: "ゲスト（参加していないキャラが名前つきで入ることがある）",
    mobLabel: "モブ（住民・生徒などの名前のない人々が入ることがある）",
    narrationLabel: "ナレーション（背景説明・場面転換・時間経過の説明が入ることがある）",
    maxMembersError: "グループは最大8人までです。",
    selectRequired: "キャラクターを1人以上選んでください。",
    createFailed: "作成に失敗しました",
    create: "作成する",
  },

  // ------------------------------------------------------------ ゲスト・モブ許可の共通ラベル
  guestMob: {
    allowGuestsAria: "ゲストを許可する",
    allowMobsAria: "モブを許可する",
    allowNarrationAria: "ナレーションを許可する",
  },

  // ------------------------------------------------------------ 「自動」（議題の自動投下・自動投稿）
  autoTopic: {
    sourceLabels: {
      news: "時事ネタ",
      interest: "キャラの興味",
      profile: "プロフィール",
      muse: "Museの出来事",
      context: "会話の流れ",
      season: "季節・今日は何の日",
      hypothetical: "もしも・二択",
      contrast: "キャラ対比",
    } as Record<string, string>,
    hint: "トークの前ならランダムな議題、トーク中なら会話にちなんだ議題を出します。たまに無関係な話も出ます。",
    cardHeading: (label: string | undefined) => (label ? `自動（${label}）` : "自動"),
    sheetAria: AUTO_TOPIC_SETTINGS,
    sheetTitle: AUTO_TOPIC_SETTINGS,
    sheetIntro: (hint: string) =>
      `「自動」は、話題を自動で出してくれる機能です。${hint}出所は、時事ネタ（人気記事から）・キャラのプロフィールや興味・季節や今日は何の日・もしもや二択・キャラ同士の対比などです。`,
    sheetAutoPostDesc:
      "自動投稿をオンにすると、会話が一区切りして、あなたの入力待ちのまま30分動きがなかった時に、議題が1つ自動で投稿されてキャラクターが反応します。あなたの発言がないままの自動投稿は連続3回までで止まり、あなたが発言すると数え直します。生成中・返信待ちの間は投稿されません。",
    autoPostToggleAria: "自動の自動投稿をオンにする",
    autoPostLabel: "自動投稿",
    autoPostDesc: "入力待ちが30分続いたら、議題を自動で投稿します（既定はオフ）。",
    menuLabel: AUTO_TOPIC_SETTINGS,
    menuDescChat:
      "トークの前ならランダム、トーク中なら会話にちなんだ議題を自動で出します。入力待ちが30分続いた時の自動投稿もここで設定します（このキャラとの会話だけの設定です）",
    postFailed: "議題の投下に失敗しました",
    pendingBanner: "議題を準備中です…少し待つと議題が投稿されます。",
    buttonAria: "自動で議題を投下する",
    buttonLabel: "自動",
    buttonHint: (hint: string) => `「自動」: ${hint}`,
    chatTargetName: (name: string) => `${name}とのチャット`,
    groupTargetName: GROUP_TARGET_NAME,
  },

  // ------------------------------------------------------------ 1対1チャット
  chat: {
    settings: "設定",
    settingsAria: "チャット設定",
    export: "全文出力",
    historyToggleAria: "過去の履歴を使うかどうかを切り替える",
    historyOn: "履歴 ON",
    historyOff: "履歴 OFF",
    historyOffNote: "履歴がオフのため、生成では過去の会話を参照しません。",
    emptyLine1: "まだ会話がありません。下の入力欄から話しかけてみてください。",
    emptyLine2: "送信すると、自動で返信が届きます。",
    cancelSend: "送信を取り消す",
    cancelSendAria: "この送信を取り消す",
    closeNoticeAria: "通知を閉じる",
    inputLabel: "メッセージ",
    waitingPlaceholder: "返信待ちです（返信が来るまで送信できません）",
    inputPlaceholder: "メッセージを書く",
    send: "送信",
    cancelDoneNotice: "送信を取り消しました。文章を入力欄に戻しました。",
    cancelTooLateNotice: "生成が始まっているため、取り消せませんでした。",
    sendFailed: "送信に失敗しました",
    cancelFailed: "取り消しに失敗しました",
    historyChangeFailed: "履歴設定の変更に失敗しました",
    waitingError: "返信が来るまで送信できません。",
    emptyMessageError: "メッセージを入力してください。",
    clearConfirmTitle: "履歴をクリアしますか？",
    clearConfirmBody: "このキャラクターとの会話ログが全て消えます。元には戻せません。",
    clearConfirm: "クリアする",
  },

  // ------------------------------------------------------------ 1対1チャットの設定メニュー
  chatMenu: {
    menuAria: "チャット設定メニュー",
    title: (name: string) => `${name}の設定`,
    clearHistory: "チャット履歴を削除",
    clearHistoryDesc: "このキャラクターとの会話ログを全て消します（元には戻せません）",
  },

  // ------------------------------------------------------------ なりきり設定シート
  roleplay: {
    title: "なりきり設定",
    description:
      "自分がなりきるキャラクターを選ぶと、あなたの送信がそのキャラのアイコンと名前の付いた吹き出しになります（自分が書いた物だと分かるよう、色は通常の送信と同じ色になります）。",
    characterHeading: "なりきるキャラクター",
    noneAria: "なりきらない",
    noneLabel: "なりきらない（未選択）",
    asAria: (name: string) => `${name}になりきる`,
    linesHeading: "なりきりキャラの台詞",
    aiAlsoLabel: "AIも演じる",
    aiAlsoDesc:
      "AIが返信し、その後のなりきりキャラの台詞もAIが考えて続けます。なりきりキャラは、あなたとAIの共同になります。",
    selfOnlyLabel: "自分だけが演じる",
    selfOnlyDesc:
      "AIは他のキャラだけで返信して続けます。なりきりキャラの台詞はAIは書きません。そのキャラが話すのは、あなたが打った時だけです。",
    apply: "設定する",
  },

  // ------------------------------------------------------------ グループ設定メニュー
  groupMenu: {
    menuAria: "グループ設定メニュー",
    title: (name: string) => `${name}の設定`,
    rename: "グループチャットの名前を変える",
    renameDesc: "このグループの表示名を変更します（参加者や会話履歴には影響しません）",
    editMembers: "グループチャットの参加者を変える",
    editMembersDesc:
      "参加キャラクターを1〜8人の間で増やしたり減らしたりできます（会話履歴は残ります）",
    guestMob: "生成内容の設定",
    guestMobDesc:
      "参加者以外のキャラクター（ゲスト）や名前のない人々（モブ）が会話に混じることがあるかと、背景説明・場面転換のナレーションを入れるかを選びます",
    autoTopic: AUTO_TOPIC_SETTINGS,
    autoTopicDesc:
      "トークの前ならランダム、トーク中なら会話にちなんだ議題を自動で出します。入力待ちが30分続いた時の自動投稿もここで設定します（このグループだけの設定です）",
    deleteGroup: "グループを削除",
    deleteGroupDesc: GROUP_DELETE_DESC,
  },

  // ------------------------------------------------------------ 生成内容の設定シート（ゲスト・モブ・ナレーション）
  groupGuestMob: {
    title: "生成内容の設定",
    intro: "オンにすると、会話の流れに応じて参加者以外のキャラや人々が混じることがあります。",
    guestLabel: "ゲスト",
    guestDesc:
      "参加していないキャラクターが会話に入ることがあります。登録済みのキャラクターは、その設定を参考にします。",
    mobLabel: "モブ",
    mobDesc: "名前のない人々が、一般名詞の表記で会話に入ることがあります。",
    narrationLabel: "ナレーション",
    narrationDesc:
      "背景説明・場面転換・時間経過の説明が、誰の台詞でもない形で入ることがあります。吹き出しではなく、中央揃えで表示されます。",
  },

  // ------------------------------------------------------------ フレーバー（旧「背景情報」）
  flavors: {
    button: "フレーバー",
    buttonWithCount: (n: number) => `フレーバー（${n}）`,
    buttonAria: "フレーバーを選ぶ",
    title: "フレーバー",
    description:
      "フレーバーツールで出力されたテキストを貼ると、このチャットの生成に絶対のルールとして添えられます。複数指定できます。過去の会話が内容に沿っていなくても、今後は必ず内容が優先されます。キャラクター自身はこの内容を知っているわけではなく、台詞で直接口にすることはありません。",
    currentHeading: "指定中のフレーバー",
    empty: "まだフレーバーは指定されていません。",
    remove: "外す",
    removeAria: (title: string) => `フレーバー「${title}」を外す`,
    showText: "本文を見る",
    hideText: "本文を隠す",
    addHeading: "フレーバーを追加",
    pasteLabel: "フレーバーのテキスト",
    pastePlaceholder: "フレーバーツールの出力テキストを貼り付け",
    addButton: "追加する",
    emptyPasteError: "フレーバーのテキストを貼ってください。",
    alreadyAddedError: "そのフレーバーはすでに指定されています。",
    saveFailed: "フレーバーの保存に失敗しました",
    historyHeading: "フレーバー履歴",
    historyNote:
      "新しく指定したフレーバーが、アプリ全体で最大10件まで残ります。選ぶと、このチャットに追加されます。",
    historyEmpty: "履歴はまだありません。",
    historyAddAria: (title: string) => `履歴から「${title}」を追加`,
    historyAdded: "指定中",
  },

  // ------------------------------------------------------------ グループ名変更シート
  renameGroup: {
    title: "グループチャットの名前を変える",
    description: "一覧やグループ画面で表示される名前を変えます。参加者や会話履歴には影響しません。",
    label: "グループ名",
    nameRequired: "グループ名を入力してください。",
    autoTitleLabel: "名前はおまかせ",
    autoTitleDesc:
      "オンにすると、返信が生成されるたびに、その掛け合いの内容を要約したタイトルがグループ名に代入され直します。",
  },

  // ------------------------------------------------------------ 参加者変更シート
  groupMembers: {
    title: "グループチャットの参加者を変える",
    description:
      "参加キャラクターは1〜8人です。外したキャラクターは会話に参加しなくなりますが、過去の発言は名前と画像つきで会話履歴にそのまま残ります。",
    membersHeading: (n: number) => `参加キャラクター（現在 ${n}人）`,
    charactersLoadFailed: "キャラクター一覧の読み込みに失敗しました。",
    inGroupBadge: "参加中",
    roleplayRemovedWarning: (name: string) =>
      `なりきり中の「${name}」を外すと、なりきりは解除され未選択に戻ります。`,
    roleplayClearedNotice:
      "参加者を変更しました。なりきり中のキャラクターが外れたため、なりきりは解除されました。",
    minMembersError: "参加者は1人以上選んでください。",
    overMembersError: "参加者は8人までです。",
  },

  // ------------------------------------------------------------ グループチャット
  group: {
    fallbackName: "グループ",
    settingsAria: "グループ設定",
    settings: "設定",
    historyTab: (on: boolean) => `履歴 ${on ? "ON" : "OFF"}`,
    export: "全文出力",
    roleplayButton: "なりきり",
    deletedSuffix: "（削除済み）",
    roleplayChip: (name: string, mode: string) => `なりきり中: ${name}（${mode}）`,
    dissolvedNote:
      "このグループは解散済みです（参加キャラクターが2人未満になりました）。ログの閲覧のみできます。",
    empty: "まだ掛け合いがありません。下の入力欄に話題や指示を書いて投稿すると、自動で掛け合いが始まります。",
    topicTime: (clock: string) => `話題 ${clock}`,
    rawHeading: "分割できなかった出力",
    historyOffNote: "履歴がオフのため、生成では過去の会話を参照しません。",
    inputLabel: "話題・指示",
    waitingPlaceholder: "掛け合い待ちです（届くまで投稿できません）",
    roleplayPlaceholder: (name: string) => `${name}として発言する`,
    inputPlaceholder: "話題や指示を書く（例: 初めて会った時の話をして）",
    post: "投稿",
    speak: "発言",
    waitingError: "掛け合いが来るまで投稿できません。",
    emptySpeechError: "発言を入力してください。",
    emptyTopicError: "話題や指示を入力してください。",
    deleteConfirmTitle: "グループを削除しますか？",
    deleteConfirmBody: "グループと掛け合いログが全て消えます。元には戻せません。",
  },
} as const;
