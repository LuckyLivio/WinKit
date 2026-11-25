export type Locale = "zh-CN" | "en-US";
export type ThemePreference = "light" | "dark" | "system";

export interface Messages {
  appName: string;
  nav: {
    home: string;
    favorites: string;
    recent: string;
    pdfReader: string;
    settings: string;
    availableToolsHeading: string;
  };
  categories: {
    all: string;
    pdf: string;
    video: string;
    audio: string;
    developer: string;
    text: string;
    image: string;
    file: string;
  };
  topbar: {
    searchPlaceholder: string;
    searchShortcutHint: string;
    runningTasksCount: (count: number) => string;
    themeToggleLabel: string;
    languageToggleLabel: string;
  };
  home: {
    titleAll: string;
    titleFavorites: string;
    titleRecent: string;
    subtitleAvailable: (count: number) => string;
    scopeFull: string;
    scopePartial: string;
    openTool: string;
    favoriteAdd: string;
    favoriteRemove: string;
    emptySearch: string;
    emptyFavorites: string;
    emptyRecent: string;
    emptyRegistry: string;
    clearSearch: string;
    baselineFooter: string;
  };
  settings: {
    title: string;
    subtitle: string;
    appearanceSection: string;
    themeLabel: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    languageSection: string;
    languageLabel: string;
    langZh: string;
    langEn: string;
    privacySection: string;
    privacySessionNote: string;
    privacyLocalNote: string;
    clearRecentButton: string;
    clearRecentDone: string;
    resetPrefsButton: string;
    resetPrefsDone: string;
    runtimeSection: string;
  };
  closeGuard: {
    title: string;
    recordingTitle: string;
    drainingTitle: string;
    errorTitle: string;
    body: (count: number, writeCount: number) => string;
    recordingBody: string;
    bodyFinished: string;
    drainingBody: string;
    timeoutBody: (remaining: string) => string;
    stayButton: string;
    stopAndKeepButton: string;
    quitAnywayButton: string;
    discardAndQuitButton: string;
    exitNowButton: string;
    retryQuitButton: string;
  };
  errors: {
    APP_SHUTTING_DOWN: string;
    FILE_NOT_FOUND: string;
    IS_DIRECTORY: string;
    SAME_INPUT_AND_OUTPUT: string;
    TARGET_ALREADY_EXISTS: string;
    PERMISSION_DENIED: string;
    FILE_LOCKED: string;
    FILE_MODIFIED_DURING_READ: string;
    DISK_FULL: string;
    SIZE_LIMIT_EXCEEDED: string;
    DECODE_FAILED: string;
    MODEL_MISSING: string;
    MODEL_INVALID: string;
    MODEL_LOAD_FAILED: string;
    INFERENCE_FAILED: string;
    MEDIA_TOOLS_MISSING: string;
    MEDIA_TOOLS_INVALID: string;
    YTDLP_MISSING: string;
    YTDLP_INVALID: string;
    LOGIN_REQUIRED: string;
    AGE_RESTRICTED: string;
    GEO_BLOCKED: string;
    DRM_PROTECTED: string;
    ACCESS_FORBIDDEN: string;
    NOT_FOUND: string;
    JS_RUNTIME_REQUIRED: string;
    UNSUPPORTED_URL: string;
    NETWORK_ERROR: string;
    DOWNLOAD_FAILED: string;
    CHECKSUM_MISMATCH: string;
    MEDIA_PROCESS_FAILED: string;
    MIC_PERMISSION_DENIED: string;
    NO_MICROPHONE_AVAILABLE: string;
    AUDIO_DEVICE_IN_USE: string;
    AUDIO_DEVICE_DISCONNECTED: string;
    AUDIO_DEVICE_NOT_FOUND: string;
    EMPTY_RECORDING: string;
    PDF_PASSWORD_REQUIRED: string;
    PDF_WRONG_PASSWORD: string;
    PDF_NOT_ENCRYPTED: string;
    PDF_ALREADY_ENCRYPTED: string;
    PDF_UNSUPPORTED_SECURITY: string;
    PDF_CORRUPT_OR_INVALID: string;
    PDF_PAGE_ERROR: string;
    PDF_RENDER_FAILED: string;
    PDF_ENGINE_MISSING: string;
    PDF_ENGINE_INVALID: string;
    PDF_ENGINE_LOAD_FAILED: string;
    PDF_QPDF_UNAVAILABLE: string;
    PDF_QPDF_INVALID: string;
    PDF_ENCRYPT_VERIFY_FAILED: string;
    PDF_DECRYPT_VERIFY_FAILED: string;
    PDF_MARKDOWN_ENGINE_MISSING: string;
    PDF_WORKER_TIMEOUT: string;
    PDF_WORKER_CRASHED: string;
    PDF_WORKER_ERROR: string;
    OCR_ENGINE_MISSING: string;
    OCR_ENGINE_LOAD_FAILED: string;
    OCR_INFERENCE_FAILED: string;
    OCR_WORKER_TIMEOUT: string;
    OCR_WORKER_CRASHED: string;
    OCR_WORKER_ERROR: string;
    ASR_MODEL_MISSING: string;
    ASR_MODEL_INVALID: string;
    ASR_ENGINE_LOAD_FAILED: string;
    ASR_INFERENCE_FAILED: string;
    ASR_WORKER_TIMEOUT: string;
    ASR_WORKER_CRASHED: string;
    ASR_WORKER_ERROR: string;
    MATTING_MODEL_MISSING: string;
    MATTING_ENGINE_LOAD_FAILED: string;
    MATTING_INFERENCE_FAILED: string;
    MATTING_WORKER_TIMEOUT: string;
    MATTING_WORKER_CRASHED: string;
    MATTING_WORKER_ERROR: string;
    MATTING_RESULT_EXPIRED: string;
    ORT_RUNTIME_MISSING: string;
    PDF_WRITE_FAILED: string;
    TASK_CANCELLED: string;
    INVALID_PARAMETER: string;
    FALLBACK: string;
  };
  jsonTool: {
    inputLabel: string;
    outputLabel: string;
    placeholder: string;
    formatBtn: string;
    minifyBtn: string;
    validateBtn: string;
    openFileBtn: string;
    saveFileBtn: string;
    copyBtn: string;
    copiedBadge: string;
    clearBtn: string;
    indentLabel: string;
    indent2: string;
    indent4: string;
    indentTab: string;
    sortKeysLabel: string;
    statusEmpty: string;
    statusValid: (kind: string) => string;
    statusInvalid: string;
    locateErrorBtn: string;
    lineColLabel: (line: number, col: number) => string;
    precisionNotice: string;
    duplicateKeyNotice: (count: number) => string;
    dropHint: string;
    savedSuccess: (path: string) => string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
  };
  hashTool: {
    modeText: string;
    modeFile: string;
    algorithmsLabel: string;
    scopeNote: string;
    compatNote: string;
    textInputLabel: string;
    textPlaceholder: string;
    exactBytesNote: string;
    byteCount: (bytes: number) => string;
    selectFileBtn: string;
    dropFileHint: string;
    selectedFileLabel: string;
    fileSizeLabel: string;
    computeBtn: string;
    recomputeWithNewAlgsBtn: string;
    cancelBtn: string;
    resumeIncompleteBtn: (count: number) => string;
    retryFailedBtn: (count: number) => string;
    saveCsvBtn: string;
    formulaProtectionLabel: string;
    uppercaseLabel: string;
    digestLabel: string;
    copyBtn: string;
    copyAllBtn: string;
    copyBatchBtn: (count: number) => string;
    copiedBadge: string;
    clearBtn: string;
    staleNotice: string;
    batchAlgSnapshotLabel: (algs: string) => string;
    batchOverflowNotice: (limit: number, skipped: number) => string;
    batchResumeRuleNote: string;
    batchSummaryCounts: (
      total: number,
      done: number,
      running: number,
      pending: number,
      errors: number,
      cancelled: number,
    ) => string;
    filterAll: string;
    filterIncomplete: string;
    filterError: string;
    filterCompleted: string;
    pageInfo: (start: number, end: number, total: number) => string;
    prevPageBtn: string;
    nextPageBtn: string;
    itemStatusLabels: {
      pending: string;
      running: string;
      completed: string;
      error: string;
      cancelled: string;
    };
    compareRowBadges: {
      match: string;
      mismatch: string;
      uncomputed: string;
      ambiguous: string;
      invalid: string;
    };
    emptyDigestsHint: string;
    compareLabel: string;
    comparePlaceholder: string;
    compareIdle: string;
    compareInvalidFormat: string;
    comparePrefixMismatch: string;
    compareAmbiguousFormat: string;
    compareUncomputedCandidate: (alg: string, hexLen: number) => string;
    compareMatch: (alg: string, hexLen: number) => string;
    compareMismatch: (alg: string, hexLen: number) => string;
    statusIdle: string;
    statusStale: string;
    statusRunning: (pct: string) => string;
    statusCompleted: (count: number) => string;
    statusCancelled: string;
    statusError: string;
    savedCsvSuccess: (path: string, bytes: number) => string;
    saveAbortedChanged: string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
  };
  codecTool: {
    scopeNote: string;
    modeText: string;
    modeFile: string;
    opEncode: string;
    opDecode: string;
    formatStdB64: string;
    formatUrlB64: string;
    formatHex: string;
    formatBinary: string;
    paddingLabel: string;
    strictPaddingDecodeLabel: string;
    wrapLabel: string;
    wrapNone: string;
    wrap64: string;
    wrap76: string;
    ignoreWsLabel: string;
    upperHexLabel: string;
    groupBitsLabel: string;
    inputLabel: string;
    outputLabel: string;
    textPlaceholderEncode: string;
    textPlaceholderDecode: string;
    selectFileBtn: string;
    dropFileHint: string;
    runFileBtn: string;
    copyFullBtn: string;
    copiedBadge: string;
    saveOutputBtn: string;
    clearBtn: string;
    statsSummary: (inBytes: number, outBytes: number) => string;
    truncationBanner: (shownChars: number, totalChars: number, outBytes: number) => string;
    binaryNonUtf8Banner: (outBytes: number) => string;
    hexPreviewHeading: string;
    savedSuccess: (path: string, bytes: number) => string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
    emptyOutput: string;
  };
  uuidTool: {
    scopeNote: string;
    generatePaneTitle: string;
    inspectPaneTitle: string;
    versionV4: string;
    versionV7: string;
    countLabel: string;
    uppercaseLabel: string;
    hyphensLabel: string;
    generateBtn: string;
    copyAllBtn: string;
    copySingleBtn: string;
    copiedBadge: string;
    clearBtn: string;
    emptyGenerated: string;
    inspectPlaceholder: string;
    inspectValid: string;
    inspectInvalid: string;
    fieldCanonical: string;
    fieldVersion: string;
    fieldVariant: string;
    fieldTimestamp: string;
    fieldNotes: string;
    v4NoTimestampNote: string;
    unsupportedTimeVersionNote: (ver: number) => string;
    nilNote: string;
    maxNote: string;
  };
  timestampTool: {
    scopeNote: string;
    modeToDate: string;
    modeToTs: string;
    nowBtn: string;
    clearBtn: string;
    copyBtn: string;
    copiedBadge: string;
    tsInputLabel: string;
    tsPlaceholder: string;
    unitLabel: string;
    unitSec: string;
    unitMs: string;
    unitUs: string;
    unitNs: string;
    usedUnitBadge: (unit: string) => string;
    suggestedUnitHint: (suggested: string, applyLabel: string) => { text: string; btn: string };
    subMsPrecisionNote: (subMsText: string) => string;
    dateInputLabel: string;
    datePlaceholder: string;
    interpretTzLabel: string;
    displayTzLabel: string;
    tzPlaceholder: string;
    cardUtc: string;
    cardLocal: (tz: string) => string;
    cardCustom: (tz: string) => string;
    isoLabel: string;
    offsetLabel: string;
    localCivilLabel: string;
    epochSecLabel: string;
    epochMsLabel: string;
    epochUsLabel: string;
    epochNsLabel: string;
    precisionTruncatedNote: string;
    emptyPrompt: string;
  };
  wordCounterTool: {
    scopeNote: string;
    inputLabel: string;
    placeholder: string;
    clearBtn: string;
    copySummaryBtn: string;
    copiedBadge: string;
    statWords: string;
    statCharsWithSpaces: string;
    statCharsNoWhitespace: string;
    statSentences: string;
    statParagraphs: string;
    statLines: string;
    statUtf8Bytes: string;
    statReadingTime: string;
    statSpeakingTime: string;
    estimateAssumptions: string;
    rulesNote: string;
    topWordsTitle: string;
    topWordsEmpty: string;
    limitExceeded: (maxMb: number) => string;
    formatDuration: (seconds: number) => string;
  };
  caseConverterTool: {
    scopeNote: string;
    inputLabel: string;
    outputLabel: string;
    placeholder: string;
    copyBtn: string;
    copiedBadge: string;
    clearBtn: string;
    stylesLabel: string;
    lineRuleNote: string;
    emptyPreview: string;
    styleNames: {
      uppercase: string;
      lowercase: string;
      title: string;
      sentence: string;
      camel: string;
      pascal: string;
      snake: string;
      constant: string;
      kebab: string;
      dot: string;
      alternating: string;
      inverse: string;
    };
  };
  beautifierTool: {
    scopeNote: string;
    selectImageBtn: string;
    replaceImageBtn: string;
    clearImageBtn: string;
    dropImageHint: string;
    previewLabel: string;
    sourceSizeLabel: string;
    outputSizeLabel: string;
    noUpscaleNote: string;
    bgColorLabel: string;
    customColorLabel: string;
    paddingLabel: string;
    radiusLabel: string;
    shadowLabel: string;
    aspectLabel: string;
    aspectOriginal: string;
    aspectSquare: string;
    aspectWide: string;
    exportPngBtn: string;
    exportingBtn: string;
    exportedSuccess: (path: string, w: number, h: number) => string;
    emptyTitle: string;
    emptyDesc: string;
    limitHint: string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
  };
  jwtTool: {
    scopeNote: string;
    tokenInputLabel: string;
    tokenPlaceholder: string;
    sampleHs256Btn: string;
    clearBtn: string;
    envelopeStrippedNote: (bearer: boolean, quotes: boolean) => string;
    statusSectionLabel: string;
    dimStructureLabel: string;
    dimSignatureLabel: string;
    dimTimeLabel: string;
    structEmpty: string;
    structValidJws: (alg: string) => string;
    structJweEncrypted: string;
    structInvalid: string;
    jweUnsupportedBody: string;
    sigUnverified: string;
    sigVerifying: string;
    sigValid: (alg: string, keyBytes: number) => string;
    sigInvalid: string;
    sigAlgMismatch: (headerAlg: string, expectedAlg: string) => string;
    sigUnsignedNone: string;
    sigUnsupportedAlg: (alg: string) => string;
    sigUnsupportedCrit: (crit: string) => string;
    sigInvalidBase64Key: string;
    nonAuthDisclaimer: string;
    remoteKeyHintWarning: string;
    unsecuredNonEmptySigWarning: string;
    precisionNote: string;
    verifierSectionTitle: string;
    expectedAlgLabel: string;
    expectedAlgAuto: string;
    secretModeLabel: string;
    secretModeUtf8: string;
    secretModeBase64: string;
    secretInputLabel: string;
    secretPlaceholderUtf8: string;
    secretPlaceholderBase64: string;
    showSecretBtn: string;
    hideSecretBtn: string;
    timeActive: string;
    timeExpired: string;
    timeNotYetValid: string;
    timeNoWindow: string;
    timeInvalidClaim: string;
    evaluatedAtLabel: string;
    headerSectionTitle: string;
    payloadSectionTitle: string;
    rawSegmentsSectionTitle: string;
    registeredClaimsTitle: string;
    copyHeaderJsonBtn: string;
    copyPayloadJsonBtn: string;
    copyRawHeaderBtn: string;
    copyRawPayloadBtn: string;
    copyRawSigBtn: string;
    copiedBadge: string;
    claimMissing: string;
    claimInvalidType: (raw: string) => string;
    claimOutOfRange: (raw: string) => string;
    claimZeroEpochBadge: string;
    claimNames: {
      iss: string;
      sub: string;
      aud: string;
      jti: string;
      exp: string;
      nbf: string;
      iat: string;
    };
  };
  diffTool: {
    scopeNote: string;
    leftTitle: string;
    rightTitle: string;
    leftPlaceholder: string;
    rightPlaceholder: string;
    openLeftBtn: string;
    openRightBtn: string;
    swapBtn: string;
    recompareBtn: string;
    clearBtn: string;
    toggleInputsShow: string;
    toggleInputsHide: string;
    dropSideLabel: string;
    dropSideLeft: string;
    dropSideRight: string;
    droppedTwoFilesInfo: (leftName: string, rightName: string, extraIgnored: boolean) => string;
    viewSideBySide: string;
    viewInline: string;
    ignoreWhitespaceLabel: string;
    ignoreCaseLabel: string;
    prevHunkBtn: string;
    nextHunkBtn: string;
    hunkIndicator: (current: number, total: number) => string;
    copyPatchBtn: string;
    copiedBadge: string;
    savePatchBtn: string;
    savedPatchSuccess: (path: string) => string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
    statusComputing: string;
    statusExactIdentical: (lines: number) => string;
    statusFilteredIdenticalRawDiffers: string;
    statusDiffSummary: (hunks: number, added: number, deleted: number) => string;
    filterPatchNotice: string;
    fallbackLargeEditNotice: string;
    expandContextBtn: (count: number) => string;
    showMoreRowsBtn: (shown: number, total: number) => string;
    noEofNewlineBadge: string;
    bomBadge: string;
    emptyDiffHint: string;
  };
  regexTool: {
    engineBadge: string;
    scopeNote: string;
    patternLabel: string;
    patternPlaceholder: string;
    flagsLabel: string;
    flagsInputAria: string;
    testTextLabel: string;
    testTextPlaceholder: string;
    openTextFileBtn: string;
    stopWorkerBtn: string;
    clearBtn: string;
    enableReplaceLabel: string;
    replacementLabel: string;
    replacementPlaceholder: string;
    replacementSyntaxHint: string;
    offsetUnitNote: string;
    statusEmptyPattern: string;
    statusRunning: string;
    statusInvalidRegex: (msg: string) => string;
    statusTimeout: (ms: number) => string;
    statusCancelled: string;
    statusWorkerError: (msg: string) => string;
    statusNoMatch: (ms: number) => string;
    statusMatched: (count: number, ms: number, truncated: boolean) => string;
    matchesTruncatedWarn: (max: number) => string;
    highlightTruncatedWarn: (max: number) => string;
    replacePreviewTruncatedWarn: (shown: number, full: number) => string;
    highlightPaneTitle: string;
    matchesPaneTitle: string;
    replacementPaneTitle: string;
    copyMatchesBtn: string;
    copyReplacementBtn: string;
    copiedBadge: string;
    colMatchNum: string;
    colMatchText: string;
    colUtf16Range: string;
    colLineCol: string;
    colCaptures: string;
    zeroLengthBadge: string;
    unmatchedGroupBadge: string;
  };
  unicodeTool: {
    scopeNote: (version: string) => string;
    confusableNeutralNote: string;
    inputLabel: string;
    inputPlaceholder: string;
    openFileBtn: string;
    sampleBtn: string;
    clearBtn: string;
    attentionOnlyLabel: (count: number) => string;
    summaryStats: (cp: number, utf16: number, graphemes: number, bytes: number) => string;
    tablePaneTitle: string;
    pageInfo: (start: number, end: number, total: number) => string;
    prevPageBtn: string;
    nextPageBtn: string;
    colCpIdx: string;
    colUtf16: string;
    colGrapheme: string;
    colHex: string;
    colGlyph: string;
    colName: string;
    colCategoryScript: string;
    colUtf8: string;
    colFlags: string;
    flagLabels: {
      bom: string;
      zero_width: string;
      joiner_or_variation_selector: string;
      bidi_control: string;
      special_whitespace: string;
      control_char: string;
      combining_mark: string;
      potential_confusable: string;
      private_or_unassigned: string;
    };
    confusableProtoPrefix: string;
    sanitizerPaneTitle: string;
    optRemoveBom: string;
    optRemoveZeroWidth: string;
    optNormalizeSpaces: string;
    optRemoveControls: string;
    optRemoveBidi: string;
    optRemoveJoiners: string;
    optReplaceConfusables: string;
    changesSummary: (count: number, truncated: boolean) => string;
    noChangesNote: string;
    previewLabel: string;
    copyCleanedBtn: string;
    saveCleanedBtn: string;
    copiedBadge: string;
    savedSuccess: (path: string) => string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
    emptyHint: string;
  };
  cleanLinksTool: {
    scopeNote: (ruleVersion: string) => string;
    inputLabel: string;
    inputPlaceholder: string;
    readClipboardBtn: string;
    replaceClipboardBtn: string;
    sampleBtn: string;
    clearBtn: string;
    copyAllBtn: (count: number) => string;
    copySingleBtn: string;
    copiedBadge: string;
    rulesSummaryTitle: string;
    rulesSummaryBody: string;
    clipboardReadEmpty: string;
    clipboardLoadedPreview: string;
    clipboardReplacedOk: (changed: number, total: number) => string;
    clipboardKeptNonLinks: string;
    clipboardLimitExceeded: string;
    statusEmpty: string;
    statusLimitBytes: (actual: number, limit: number) => string;
    statusLimitLines: (actual: number, limit: number) => string;
    statusSummary: (
      valid: number,
      changed: number,
      removedParams: number,
      unwrapped: number,
      invalid: number,
    ) => string;
    resultsPaneTitle: string;
    cleanedOutputPaneTitle: string;
    linePrefix: (n: number) => string;
    badgeCleaned: string;
    badgeUnchanged: string;
    badgePresignedSkipped: (key: string) => string;
    badgeInvalid: string;
    removedParamsLabel: string;
    scopeUniversal: string;
    scopeSite: string;
    unwrappedChainLabel: string;
    unwrapStoppedNote: {
      missing_target_param: (provider: string) => string;
      ambiguous_target_param: (provider: string) => string;
      malformed_target_encoding: (provider: string) => string;
      non_http_or_invalid_target: (provider: string) => string;
      target_too_long: (provider: string) => string;
      cycle_detected: (provider: string) => string;
      max_depth_reached: (depth: number) => string;
    };
    invalidReasons: {
      not_http_url: string;
      contains_whitespace_or_control: string;
      url_too_long: string;
      malformed_url: string;
    };
    malformedKeyPreservedNote: (count: number) => string;
  };
  loremTool: {
    scopeNote: string;
    unitLabel: string;
    unitWords: string;
    unitSentences: string;
    unitParagraphs: string;
    countLabel: (min: number, max: number) => string;
    formatLabel: string;
    formatPlain: string;
    formatHtml: string;
    formatMarkdown: string;
    classicStartLabel: string;
    regenerateBtn: string;
    copyBtn: string;
    copiedBadge: string;
    clearBtn: string;
    outputPaneTitle: string;
    statusStats: (words: number, sentences: number, paragraphs: number, chars: number) => string;
    statusCleared: string;
    errNonInteger: string;
    errOutOfRange: (min: number, max: number) => string;
    errBudgetExceeded: (maxChars: number) => string;
  };
  passwordTool: {
    scopeNote: string;
    modePassword: string;
    modePassphrase: string;
    batchCountLabel: string;
    passwordLengthLabel: string;
    wordCountLabel: string;
    charClassesTitle: string;
    optUppercase: string;
    optLowercase: string;
    optDigits: string;
    optSymbols: string;
    optExcludeLookAlikes: string;
    optRequireEachClass: string;
    passphraseOptionsTitle: string;
    separatorLabel: string;
    sepHyphen: string;
    sepSpace: string;
    sepDot: string;
    sepUnderscore: string;
    sepNone: string;
    optCapitalize: string;
    optIncludeNumber: string;
    generateBtn: string;
    regenerateBtn: string;
    revealBtn: string;
    hideBtn: string;
    copyBatchBtn: (count: number) => string;
    copySingleBtn: string;
    copiedBadge: string;
    clearBtn: string;
    strengthTitle: string;
    tierLabels: {
      weak: string;
      fair: string;
      strong: string;
      very_strong: string;
    };
    bitsExactLabel: (bits: number) => string;
    bitsUpperBoundLabel: (bits: number) => string;
    modelAssumptions: {
      independent_uniform_chars: (poolSize: number) => string;
      constrained_all_selected_classes: (poolSize: number, upperBits: number) => string;
      independent_words_with_replacement: (dictSize: number, isUpperBound: boolean) => string;
    };
    memoryPrivacyNote: string;
    staleBanner: string;
    emptyPrompt: string;
    resultsPaneTitle: (count: number, masked: boolean) => string;
    errInvalidLength: (min: number, max: number) => string;
    errInvalidWordCount: (min: number, max: number) => string;
    errInvalidBatchCount: (min: number, max: number) => string;
    errNoCharset: string;
    errImpossibleConstraints: string;
  };
  csvJsonTool: {
    scopeNote: string;
    directionLabel: string;
    dirCsvToJson: string;
    dirJsonToCsv: string;
    dirCsvToMd: string;
    dirJsonToMd: string;
    delimiterLabel: string;
    delimAuto: string;
    delimComma: string;
    delimSemicolon: string;
    delimTab: string;
    firstRowHeaders: string;
    detectTypes: string;
    emptyCellsAsNull: string;
    formulaProtection: string;
    advancedSummaryTitle: string;
    headerPolicyLabel: string;
    headerPolicyError: string;
    headerPolicyRename: string;
    raggedPolicyLabel: string;
    raggedPolicyError: string;
    raggedPolicyPad: string;
    arrayModeLabel: string;
    arrayModeSemicolon: string;
    arrayModeJson: string;
    pathPolicyLabel: string;
    pathPolicyError: string;
    pathPolicyBracket: string;
    csvEolLabel: string;
    csvBomLabel: string;
    mappingRulesNote: string;
    openFileBtn: string;
    sampleBtn: string;
    cancelWorkerBtn: string;
    copyBtn: string;
    copiedBadge: string;
    saveBtn: string;
    clearBtn: string;
    viewTextTab: string;
    viewTableTab: string;
    inputPaneTitle: (fileName: string | null) => string;
    outputPaneTitle: string;
    csvPlaceholder: string;
    jsonPlaceholder: string;
    statusEmpty: string;
    statusRunning: string;
    statusCancelled: string;
    statusOk: (rows: number, cols: number) => string;
    detectedDelimiterBadge: (delimName: string, ambiguous: boolean) => string;
    statusErrorLoc: (
      msg: string,
      physicalLine?: number,
      col?: number,
      recordNum?: number,
    ) => string;
    previewTruncatedNote: (shownChars: number, fullChars: number) => string;
    tableTruncatedNote: (
      shownRows: number,
      totalRows: number,
      shownCols: number,
      totalCols: number,
    ) => string;
    formulaDetectedWarn: (count: number) => string;
    formulaProtectedInfo: (count: number) => string;
    formulaPreviewHeading: string;
    renamedHeadersNotice: (items: string) => string;
    raggedAdjustedNotice: (padded: number, extended: number) => string;
    ambiguousArrayNotice: (count: number) => string;
    depthCappedNotice: (count: number, maxDepth: number) => string;
    singleObjectNotice: string;
    savedSuccess: (path: string, bytes: number) => string;
    saveAbortedInputChanged: string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
  };
  coordinateTool: {
    offlineBadge: string;
    scopeNote: string;
    tabSingle: string;
    tabDistance: string;
    tabBatch: string;
    modePaste: string;
    modeSeparate: string;
    plainOrderLabel: string;
    orderLatLon: string;
    orderLonLat: string;
    singleInputLabel: string;
    singlePlaceholder: string;
    latFieldLabel: string;
    lonFieldLabel: string;
    latPlaceholder: string;
    lonPlaceholder: string;
    ddDecLabel: string;
    dmDecLabel: string;
    dmsDecLabel: string;
    precisionHint: string;
    sampleBtn: string;
    clearBtn: string;
    sendToABtn: string;
    sendToBBtn: string;
    detectedBadge: (fmt: string, order: string) => string;
    detectedFormatNames: {
      separate_fields: string;
      dd: string;
      dm: string;
      dms: string;
      geojson_point: string;
      wkt_point: string;
      geo_uri: string;
      apple_maps_url: string;
      google_maps_url: string;
    };
    axisOrderNames: {
      lat_lon: string;
      lon_lat: string;
      hemisphere_tagged: string;
    };
    outputsPaneTitle: string;
    emptySinglePrompt: string;
    formatLabels: {
      dd: string;
      dms: string;
      dm: string;
      geojson: string;
      wkt: string;
      geo_uri: string;
      apple_maps: string;
      google_maps: string;
    };
    formatMeta: {
      dd: string;
      dms: string;
      dm: string;
      geojson: string;
      wkt: string;
      geo_uri: string;
      apple_maps: string;
      google_maps: string;
    };
    copyBtn: string;
    copiedBadge: string;
    pointATitle: string;
    pointBTitle: string;
    pointPlaceholder: string;
    fillFromCurrentBtn: string;
    swapPointsBtn: string;
    sampleAntipodalBtn: string;
    sampleDatelineBtn: string;
    pointAErrorPrefix: (msg: string) => string;
    pointBErrorPrefix: (msg: string) => string;
    distanceResultTitle: string;
    distanceEmptyPrompt: string;
    unitKilometers: string;
    unitMeters: string;
    unitMiles: string;
    distanceModelNote: string;
    batchInputTitle: (fileName: string | null) => string;
    batchPlaceholder: string;
    batchOutputFormatLabel: string;
    batchCsvScopeLabel: string;
    batchCsvScopeAll: string;
    batchCsvScopeValid: string;
    batchFormulaProtection: string;
    openBatchFileBtn: string;
    cancelBatchBtn: string;
    copyValidBtn: (count: number) => string;
    exportCsvBtn: string;
    batchStatusEmpty: string;
    batchStatusRunning: string;
    batchStatusCancelled: string;
    batchStatusSummary: (valid: number, errors: number, skippedBlank: number) => string;
    batchPreviewTruncated: (shown: number, total: number) => string;
    batchScopeRuleNote: string;
    colLine: string;
    colRaw: string;
    colStatus: string;
    colLat: string;
    colLon: string;
    colResultOrError: string;
    badgeOk: string;
    badgeErr: string;
    savedCsvSuccess: (path: string, bytes: number) => string;
    saveAbortedChanged: string;
    overwriteConfirmTitle: string;
    overwriteConfirmBody: (path: string) => string;
    overwriteConfirmAccept: string;
    cancel: string;
  };
}

export const MESSAGES: Record<Locale, Messages> = {
  "zh-CN": {
    appName: "WinKit",
    nav: {
      home: "全部工具",
      favorites: "收藏夹",
      recent: "最近使用",
      pdfReader: "PDF 快速预览",
      settings: "设置",
      availableToolsHeading: "当前可用工具",
    },
    categories: {
      all: "全部分类",
      pdf: "文档与 PDF",
      video: "视频",
      audio: "音频",
      developer: "开发者",
      text: "文本与语音",
      image: "图片",
      file: "文件",
    },
    topbar: {
      searchPlaceholder: "搜索可用工具…",
      searchShortcutHint: "Ctrl+K",
      runningTasksCount: (count) => `${count} 个任务运行中`,
      themeToggleLabel: "切换明暗主题",
      languageToggleLabel: "切换界面语言",
    },
    home: {
      titleAll: "可用工具",
      titleFavorites: "已收藏工具",
      titleRecent: "最近使用",
      subtitleAvailable: (count) => `当前已启用 ${count} 项本地实用工具（全部计算在本机离线完成）`,
      scopeFull: "完整支持",
      scopePartial: "部分实现",
      openTool: "打开",
      favoriteAdd: "加入收藏",
      favoriteRemove: "取消收藏",
      emptySearch: "未找到匹配当前搜索词的可用工具。",
      emptyFavorites: "暂无收藏工具。点击任意工具右侧星标即可固定在此处。",
      emptyRecent: "暂无最近打开的工具记录。",
      emptyRegistry: "当前尚未注册可用工具。",
      clearSearch: "清空筛选",
      baselineFooter:
        "仅展示当前版本已真实实现并通过验证的工具；规划条目见 docs/PARITY_MATRIX.md。",
    },
    settings: {
      title: "设置",
      subtitle: "外观、语言与本地隐私控制",
      appearanceSection: "外观主题",
      themeLabel: "色彩模式",
      themeLight: "浅色（默认）",
      themeDark: "深色",
      themeSystem: "跟随系统",
      languageSection: "界面语言",
      languageLabel: "显示语言",
      langZh: "简体中文",
      langEn: "English",
      privacySection: "会话状态与本地隐私",
      privacySessionNote:
        "工具输入内容仅在当前运行会话内存中保留，退出应用即清空，默认绝不将你的正文、文件内容、密钥或令牌写入磁盘。",
      privacyLocalNote:
        "本地仅持久化主题、语言、收藏夹与最近使用工具编号。无遥测、无账号、无云端请求。",
      clearRecentButton: "清空最近使用记录",
      clearRecentDone: "已清空最近使用记录",
      resetPrefsButton: "恢复默认外观与语言",
      resetPrefsDone: "已恢复默认偏好设置",
      runtimeSection: "运行环境信息",
    },
    closeGuard: {
      title: "仍有本地任务正在运行",
      recordingTitle: "正在进行本地录制",
      drainingTitle: "正在安全收尾并退出…",
      errorTitle: "暂时无法完成退出",
      body: (count, writeCount) =>
        writeCount > 0
          ? `当前有 ${count} 个任务尚未结束（含 ${writeCount} 个文件写入收尾步骤）。当前版本不支持在系统托盘后台继续运行；确认退出后将取消可中断任务，并等待短时文件写入安全落盘后关闭。`
          : `当前有 ${count} 个本地任务正在运行。当前版本不支持关闭窗口后在系统托盘继续运行，现在退出将取消未完成的任务并在释放文件句柄后关闭。`,
      recordingBody:
        "当前仍有正在进行的本地录音或录屏。你可以留在 WinKit 继续录制、停止并保留已录内容以便试听/保存，或直接放弃未保存内容并退出。",
      bodyFinished: "刚才运行的后台任务已经结束，现在可以直接退出 WinKit，或留在当前工作区。",
      drainingBody:
        "正在请求任务停止、等待文件写入安全收尾并释放文件句柄，请稍候（收尾期间已锁定退出流程）…",
      timeoutBody: (remaining) =>
        `等待后台任务结束超时（仍未结束：${remaining}）。为保护文件完整性未强制终止进程；你可以重试退出或先返回应用查看状态（已发出取消请求的任务不会自动恢复）。`,
      stayButton: "继续使用",
      stopAndKeepButton: "停止并保留已录内容",
      quitAnywayButton: "取消任务并退出",
      discardAndQuitButton: "放弃录制并退出",
      exitNowButton: "立即退出",
      retryQuitButton: "重试退出",
    },
    errors: {
      APP_SHUTTING_DOWN: "应用正在执行退出收尾，暂不接受新的后台任务。",
      FILE_NOT_FOUND: "找不到指定的文件或目录，请确认文件未被移动或删除。",
      IS_DIRECTORY: "所选路径是文件夹而非文件，请选择具体文件。",
      SAME_INPUT_AND_OUTPUT: "为保护原始文件，输出保存路径不能与源文件相同。",
      TARGET_ALREADY_EXISTS: "目标位置已存在同名文件，请确认覆盖或另选文件名。",
      PERMISSION_DENIED: "权限不足或目标文件夹为只读，请选择可写目录。",
      FILE_LOCKED: "文件正被其他程序占用，请关闭占用程序后重试。",
      FILE_MODIFIED_DURING_READ:
        "读取文件期间检测到大小或修改时间发生变化，已中止摘要计算以防结果失真。",
      DISK_FULL: "目标磁盘剩余空间不足，无法完成写入。",
      SIZE_LIMIT_EXCEEDED: "输入体积、输出预估或画布像素超出安全上限。",
      DECODE_FAILED: "编码内容或图像格式无法解析。",
      MODEL_MISSING: "未在安装目录中找到内置离线人脸检测模型。",
      MODEL_INVALID: "内置人脸检测模型校验失败，请重新安装 WinKit。",
      MODEL_LOAD_FAILED: "本地人脸检测模型加载失败。",
      INFERENCE_FAILED: "本地人脸检测执行失败。",
      MEDIA_TOOLS_MISSING: "尚未配置本地 FFmpeg / ffprobe 媒体组件，请先完成配置。",
      MEDIA_TOOLS_INVALID: "选定目录中的 FFmpeg / ffprobe 不可用或校验未通过。",
      YTDLP_MISSING:
        "尚未配置本地 yt-dlp 组件。网页视频或自适应清单需要 yt-dlp（普通直链媒体文件可直接使用）。",
      YTDLP_INVALID: "选定的 yt-dlp 程序不可用或版本自检未通过。",
      LOGIN_REQUIRED: "该链接需要登录账号、提供凭据或会员权限，暂不支持匿名直接下载。",
      AGE_RESTRICTED: "该内容受年龄限制，需要登录验证后才能访问。",
      GEO_BLOCKED: "该内容在当前地区受限或无法访问。",
      DRM_PROTECTED: "该媒体受 DRM 数字版权加密保护，无法下载。",
      ACCESS_FORBIDDEN: "目标服务器拒绝访问（HTTP 403），可能需要授权或受防盗链限制。",
      NOT_FOUND: "目标视频或媒体资源不存在或已被移除（HTTP 404）。",
      JS_RUNTIME_REQUIRED:
        "该站点需要外部 JavaScript 运行时（如 Deno 或 Node.js）协助解析，请安装后重新检测。",
      UNSUPPORTED_URL: "暂不支持解析该页面链接或未在页面中找到可下载视频流。",
      NETWORK_ERROR: "网络连接中断、超时或服务器暂不可达，可稍后点击重试。",
      DOWNLOAD_FAILED: "下载中断或远端返回错误，请查看详情或稍后重试。",
      CHECKSUM_MISMATCH: "下载的媒体组件包 SHA-256 摘要校验未通过，已自动丢弃。",
      MEDIA_PROCESS_FAILED: "本地媒体处理进程执行失败。",
      MIC_PERMISSION_DENIED:
        "Windows 已阻止麦克风访问权限。请前往「Windows 设置 → 隐私和安全性 → 麦克风」允许桌面应用访问麦克风后重试。",
      NO_MICROPHONE_AVAILABLE: "未检测到可用的麦克风输入设备，请接入或启用麦克风后刷新设备列表。",
      AUDIO_DEVICE_IN_USE: "所选音频设备当前被其他程序独占占用，请释放后重试。",
      AUDIO_DEVICE_DISCONNECTED: "所选音频设备已断开或被禁用。",
      AUDIO_DEVICE_NOT_FOUND: "找不到所选音频设备，请刷新设备列表后重新选择。",
      EMPTY_RECORDING: "停止前未采集到有效音频帧，未生成空录音文件。",
      PDF_PASSWORD_REQUIRED:
        "该 PDF 受打开密码保护。请使用「PDF 解除密码 (P16)」输入已知密码导出无密码副本后再预览或编辑。",
      PDF_WRONG_PASSWORD: "密码不正确，请检查大小写、空格及输入法状态后重试。",
      PDF_NOT_ENCRYPTED: "该 PDF 未加密，无需解除密码。",
      PDF_ALREADY_ENCRYPTED:
        "该 PDF 已处于加密状态，请先使用「PDF 解除密码 (P16)」解除原有密码后再重新加密。",
      PDF_UNSUPPORTED_SECURITY:
        "该 PDF 使用了非标准安全处理器（例如证书或 DRM 加密），暂不支持通过密码解锁。",
      PDF_CORRUPT_OR_INVALID: "所选文件不是有效的 PDF 文档，或内部结构已损坏。",
      PDF_PAGE_ERROR: "PDF 页面对象缺失或无法读取。",
      PDF_RENDER_FAILED: "PDF 页面渲染失败，请降低缩放倍率或检查文件。",
      PDF_ENGINE_MISSING: "安装目录中缺少内置 PDF 渲染组件（pdfium.dll），请重新安装 WinKit。",
      PDF_ENGINE_INVALID: "内置 PDF 渲染组件校验未通过，请重新安装官方安装包。",
      PDF_ENGINE_LOAD_FAILED: "内置 PDF 渲染组件加载失败。",
      PDF_QPDF_UNAVAILABLE:
        "安装目录中缺少内置 PDF 安全处理组件（qpdf30.dll），请重新安装官方安装包。",
      PDF_QPDF_INVALID: "内置 PDF 安全处理组件完整性校验未通过，请重新安装官方安装包。",
      PDF_ENCRYPT_VERIFY_FAILED: "加密结果独立校验未通过，未写入最终输出文件，请重试。",
      PDF_DECRYPT_VERIFY_FAILED:
        "解密结果独立校验未通过（输出仍需要密码或无法读取），未写入最终文件。",
      PDF_MARKDOWN_ENGINE_MISSING:
        "未在标准系统路径找到 Windows 内置 Microsoft Edge 渲染组件，无法离线生成矢量 PDF。",
      PDF_WORKER_TIMEOUT:
        "隔离 PDF 处理进程超时并已终止，主界面未受影响，请检查文件是否过大或损坏。",
      PDF_WORKER_CRASHED: "隔离 PDF 处理子进程异常中断（文件可能损坏或结构异常），主界面未受影响。",
      PDF_WORKER_ERROR: "PDF 后台处理进程通信失败，请重试。",
      OCR_ENGINE_MISSING: "离线 OCR 运行库或 RapidOCR 模型缺失，请重新安装官方安装包。",
      OCR_ENGINE_LOAD_FAILED: "加载离线 OCR 运行库或模型失败，请确认安装目录完整。",
      OCR_INFERENCE_FAILED: "本地离线 OCR 推理失败，请检查图片或扫描件是否损坏。",
      OCR_WORKER_TIMEOUT:
        "隔离 OCR 识别进程超时并已安全终止，请适当降低渲染 DPI 或缩小图片后重试。",
      OCR_WORKER_CRASHED: "隔离 OCR 识别子进程异常中止，原文件未受影响，请重试。",
      OCR_WORKER_ERROR: "OCR 后台识别进程通信失败，请重试。",
      ASR_MODEL_MISSING:
        "尚未安装离线语音识别模型（SenseVoiceSmall INT8 + Silero VAD v5），请先在上方点击下载或指定本地模型目录。",
      ASR_MODEL_INVALID: "离线语音模型文件不完整或元数据无效，请重新下载或核对目录。",
      ASR_ENGINE_LOAD_FAILED: "加载离线语音识别模型失败，请检查模型文件是否完整以及内存是否充足。",
      ASR_INFERENCE_FAILED: "本地离线语音转写推理失败，请确认音视频文件未损坏。",
      ASR_WORKER_TIMEOUT: "隔离语音转写进程长时间无进展并已安全终止，请检查输入文件后重试。",
      ASR_WORKER_CRASHED: "隔离语音转写子进程异常退出，原音视频文件未受影响，请重试。",
      ASR_WORKER_ERROR: "离线语音转写进程通信失败，请重试。",
      MATTING_MODEL_MISSING:
        "尚未安装离线抠图模型（BiRefNet_lite 512 FP16），请先在上方点击下载或指定本地模型目录。",
      MATTING_ENGINE_LOAD_FAILED: "加载离线抠图模型失败，请检查模型文件是否完整以及内存是否充足。",
      MATTING_INFERENCE_FAILED: "本地离线抠图推理失败，请确认图片未损坏后重试。",
      MATTING_WORKER_TIMEOUT: "隔离抠图进程超时并已安全终止，请检查图片尺寸后重试。",
      MATTING_WORKER_CRASHED: "隔离抠图子进程异常退出，原图片未受影响，请重试。",
      MATTING_WORKER_ERROR: "离线抠图进程通信失败，请重试。",
      MATTING_RESULT_EXPIRED: "内存中的抠图结果已过期或被清理，请重新执行离线抠图。",
      ORT_RUNTIME_MISSING: "内置 ONNX Runtime 运行库缺失，请重新安装官方安装包。",
      PDF_WRITE_FAILED: "写入目标 PDF 文件失败，请检查磁盘空间与目录权限。",
      TASK_CANCELLED: "任务已按请求取消。",
      INVALID_PARAMETER: "输入参数或路径格式无效。",
      FALLBACK: "执行本地操作时发生错误。",
    },
    jsonTool: {
      inputLabel: "JSON 输入",
      outputLabel: "处理结果",
      placeholder: "在此粘贴或输入 JSON（支持对象、数组与合法标量，或拖入本地 .json 文件）",
      formatBtn: "格式化",
      minifyBtn: "单行压缩",
      validateBtn: "仅校验",
      openFileBtn: "打开文件…",
      saveFileBtn: "另存为…",
      copyBtn: "复制结果",
      copiedBadge: "已复制",
      clearBtn: "清空",
      indentLabel: "缩进",
      indent2: "2 空格",
      indent4: "4 空格",
      indentTab: "Tab",
      sortKeysLabel: "按键名字母排序",
      statusEmpty: "等待输入 JSON 内容",
      statusValid: (kind) => `合法 JSON（根类型：${kind}）`,
      statusInvalid: "JSON 语法错误",
      locateErrorBtn: "定位错误处",
      lineColLabel: (line, col) => `第 ${line} 行，第 ${col} 列`,
      precisionNotice:
        "检测到超出 IEEE-754 安全整数范围或含精确尾随零的数值；WinKit 已通过无损词法保真原样保留，未发生精度改写。",
      duplicateKeyNotice: (count) =>
        `检测到 ${count} 处重复对象键名；已按原始顺序保留（若开启键排序同样保留全部条目）。`,
      dropHint: "松开鼠标以载入本地 JSON 文件",
      savedSuccess: (path) => `已安全保存至：${path}`,
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否覆盖该输出文件（不会修改原输入文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
    },
    hashTool: {
      modeText: "UTF-8 文本",
      modeFile: "本地文件（支持多选批处理）",
      algorithmsLabel: "摘要算法",
      scopeNote:
        "支持 UTF-8 文本与最多 1,000 个本地文件单遍流式计算 MD5、SHA-1、SHA-256、SHA-384、SHA-512（不递归扫描文件夹；同会话可暂停后继续未完成项）。",
      compatNote: "仅用于文件兼容性校验，不适用于密码存储、数字签名或来源认证",
      textInputLabel: "待计算文本",
      textPlaceholder: "输入或粘贴任意文本…",
      exactBytesNote:
        "按原始 UTF-8 字节精确计算，完整保留首尾空格、制表符与换行符，不做任何自动修剪。",
      byteCount: (bytes) => `${bytes.toLocaleString()} UTF-8 字节`,
      selectFileBtn: "选择本地文件…",
      dropFileHint:
        "支持多选或从资源管理器一次拖入多个文件（每批上限 1,000 项，每个文件单遍 256 KiB 流式读取并更新本批全部算法，不改动原文件）",
      selectedFileLabel: "当前选中文件",
      fileSizeLabel: "文件大小",
      computeBtn: "重新计算",
      recomputeWithNewAlgsBtn: "按当前算法重算本批",
      cancelBtn: "取消批次",
      resumeIncompleteBtn: (count) => `继续未完成项 (${count})`,
      retryFailedBtn: (count) => `重试失败项 (${count})`,
      saveCsvBtn: "保存 CSV…",
      formulaProtectionLabel: "CSV 公式保护",
      uppercaseLabel: "大写十六进制",
      digestLabel: "摘要计算结果",
      copyBtn: "复制",
      copyAllBtn: "复制全部",
      copyBatchBtn: (count) => `复制本批摘要 (${count})`,
      copiedBadge: "已复制",
      clearBtn: "清空",
      staleNotice:
        "工具栏所选算法与本批实际计算的算法快照不同（下方仍按本批实际已计算算法展示）；如需补算新算法，请点击“按当前算法重算本批”。",
      batchAlgSnapshotLabel: (algs) => `本批算法快照：${algs}`,
      batchOverflowNotice: (limit, skipped) =>
        `单批最多处理 ${limit.toLocaleString()} 个文件：已接收前 ${limit.toLocaleString()} 项，超出上限的 ${skipped.toLocaleString()} 个文件未加入本批，请分批添加。`,
      batchResumeRuleNote:
        "本次会话可继续：继续时保留本会话已完成文件的摘要，仅从头重新读取未完成文件（不跨进程保存中间哈希状态）。",
      batchSummaryCounts: (total, done, running, pending, errors, cancelled) =>
        `共 ${total} 项 · 完成 ${done} · 读取中 ${running} · 等待 ${pending} · 失败 ${errors} · 已取消 ${cancelled}`,
      filterAll: "全部",
      filterIncomplete: "待完成 / 已取消",
      filterError: "失败",
      filterCompleted: "已完成",
      pageInfo: (start, end, total) => `第 ${start}–${end} / 共 ${total} 项`,
      prevPageBtn: "上一页",
      nextPageBtn: "下一页",
      itemStatusLabels: {
        pending: "等待中",
        running: "读取中",
        completed: "已完成",
        error: "失败",
        cancelled: "已取消",
      },
      compareRowBadges: {
        match: "一致",
        mismatch: "不一致",
        uncomputed: "待算算法",
        ambiguous: "格式歧义",
        invalid: "格式无效",
      },
      emptyDigestsHint: "输入文本，或选择 / 拖入本地文件后在此查看选中项的摘要详情与比对状态。",
      compareLabel: "期望摘要比对（绑定当前项，可选）",
      comparePlaceholder:
        "粘贴期望摘要（支持分组 SHA-256、md5:/sha256: 前缀、标准 shasum 双空格 / *文件名、大小写或冒号分隔）",
      compareIdle:
        "输入期望摘要后检查格式并比对相等性（长度仅代表候选算法，匹配结果不构成数字签名或文件来源认证）",
      compareInvalidFormat:
        "期望值格式无效：需为合法十六进制，且长度为 32 (MD5)、40 (SHA-1)、64 (SHA-256)、96 (SHA-384) 或 128 (SHA-512) 位",
      comparePrefixMismatch:
        "算法前缀与摘要十六进制长度矛盾（例如标为 SHA-256 但仅提供 32 位十六进制），请核对前缀与摘要。",
      compareAmbiguousFormat:
        "期望值存在格式歧义：同时包含有效长度摘要与额外内容，无法确认是分组摘要还是非标准文件名后缀。请仅保留纯摘要，或使用明确前缀（如 SHA-256:）及标准 shasum 格式（双空格或 *文件名）。",
      compareUncomputedCandidate: (alg, hexLen) =>
        `按 ${hexLen} 位十六进制长度推断候选算法为 ${alg}（仅代表长度匹配），但当前批次未计算 ${alg}；请勾选 ${alg} 并重新计算后再比对`,
      compareMatch: (alg, hexLen) =>
        `一致：与当前计算的 ${alg}（${hexLen} 位十六进制）摘要完全匹配`,
      compareMismatch: (alg, hexLen) =>
        `不一致：按 ${hexLen} 位长度比对当前计算的 ${alg} 摘要，结果不匹配`,
      statusIdle: "尚未计算",
      statusStale: "算法配置已变更",
      statusRunning: (pct) => `正在单遍流式读取（${pct}）…`,
      statusCompleted: (count) => `已完成 ${count} 项摘要`,
      statusCancelled: "计算已取消（可在本会话内继续未完成项）",
      statusError: "计算失败",
      savedCsvSuccess: (path, bytes) =>
        `已安全导出批次哈希 CSV（${bytes.toLocaleString()} 字节）：${path}`,
      saveAbortedChanged:
        "批次内容或导出选项在另存对话框打开期间已变更，本次保存已取消以避免混用旧快照。",
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖批次中的任何源文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
    },
    codecTool: {
      scopeNote:
        "支持标准/URL-safe Base64、Hex 与 8 位二进制编码/解码（注：Base64 等属于数据编码而非加密算法）。文本上限 2 MiB，本地原始字节文件上限 8 MiB（二进制位编码 2 MiB）。",
      modeText: "UTF-8 文本",
      modeFile: "本地小文件（原始字节）",
      opEncode: "编码 (Encode)",
      opDecode: "解码 (Decode)",
      formatStdB64: "标准 Base64",
      formatUrlB64: "URL-Safe Base64",
      formatHex: "Hex (十六进制)",
      formatBinary: "Binary (8位二进制)",
      paddingLabel: "补充 = 填充",
      strictPaddingDecodeLabel: "要求完整 = 填充",
      wrapLabel: "换行宽度",
      wrapNone: "不换行",
      wrap64: "64 列",
      wrap76: "76 列",
      ignoreWsLabel: "忽略空白与换行",
      upperHexLabel: "大写 Hex",
      groupBitsLabel: "按字节空格分组",
      inputLabel: "输入源",
      outputLabel: "转换结果",
      textPlaceholderEncode: "输入待编码的 UTF-8 文本（保留全部空格与换行）…",
      textPlaceholderDecode: "粘贴待解码的 Base64、十六进制或 0/1 二进制字符串…",
      selectFileBtn: "选择文件…",
      dropFileHint: "或从资源管理器拖入小文件（直接按原始字节处理，绝不将二进制文件误作文本解码）",
      runFileBtn: "重新转换文件",
      copyFullBtn: "复制完整结果",
      copiedBadge: "已复制",
      saveOutputBtn: "另存为文件…",
      clearBtn: "清空",
      statsSummary: (inBytes, outBytes) =>
        `输入 ${inBytes.toLocaleString()} B → 输出 ${outBytes.toLocaleString()} B`,
      truncationBanner: (shownChars, totalChars, outBytes) =>
        `结果共 ${totalChars.toLocaleString()} 字符（${outBytes.toLocaleString()} B），界面仅预览前 ${shownChars.toLocaleString()} 字符；“复制完整结果”与“另存为文件…”均导出完整结果。`,
      binaryNonUtf8Banner: (outBytes) =>
        `解码成功，共得到 ${outBytes.toLocaleString()} 字节原始二进制数据。因包含非 UTF-8 字节序列，未将其替换为乱码文本；下方展示前 256 字节十六进制预览，请使用“另存为文件…”无损导出完整字节。`,
      hexPreviewHeading: "非 UTF-8 原始字节十六进制预览（前 256 字节）",
      savedSuccess: (path, bytes) => `已无损写入 ${bytes.toLocaleString()} 字节至：${path}`,
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖原输入文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
      emptyOutput: "输入内容或选择本地文件后在此实时查看结果。",
    },
    uuidTool: {
      scopeNote:
        "采用操作系统密码学安全随机源（CSPRNG）生成符合 RFC 9562 的 UUID v4 与时间序 v7（单批 1–500 个）。不承诺跨设备绝对唯一或系统时钟回拨下严格递增；解析器仅对受支持的时间版本提取时间，绝不为 v4 编造时间。",
      generatePaneTitle: "批量生成 UUID (v4 / v7)",
      inspectPaneTitle: "解析与校验 UUID",
      versionV4: "UUID v4（随机）",
      versionV7: "UUID v7（毫秒时间序）",
      countLabel: "数量 (1–500)",
      uppercaseLabel: "大写字母",
      hyphensLabel: "包含连字符 (-)",
      generateBtn: "生成 UUID",
      copyAllBtn: "复制全部",
      copySingleBtn: "复制",
      copiedBadge: "已复制",
      clearBtn: "清空",
      emptyGenerated: "点击“生成 UUID”创建新的安全随机标识符。",
      inspectPlaceholder: "粘贴任意带或不带连字符（或花括号/urn:uuid:）的 UUID 字符串进行解析…",
      inspectValid: "格式合法",
      inspectInvalid: "UUID 格式无效",
      fieldCanonical: "标准规范格式",
      fieldVersion: "版本 (Version)",
      fieldVariant: "变体 (Variant)",
      fieldTimestamp: "内嵌时间戳",
      fieldNotes: "解析说明",
      v4NoTimestampNote: "UUID v4 由密码学随机位组成，不包含生成时间信息。",
      unsupportedTimeVersionNote: (ver) =>
        `检测到 UUID v${ver}；当前版本仅提取 RFC 9562 UUID v7 的 Unix 毫秒时间戳，未解码 v${ver} 格里高利历时钟字段。`,
      nilNote: "全零特殊 UUID（Nil UUID，RFC 9562 §5.9）。",
      maxNote: "全 1 特殊 UUID（Max UUID，RFC 9562 §5.10）。",
    },
    timestampTool: {
      scopeNote:
        "采用 BigInt 精确整数运算（零 Number 浮点舍入）支持秒、毫秒、微秒、纳秒与日期双向互转。无偏移日期必须显式选择解释时区；若落入夏令时跳变缺失或重复小时将明确拒绝，要求提供带 UTC 偏移的字符串。",
      modeToDate: "时间戳 → 日期时间",
      modeToTs: "日期时间 → 时间戳",
      nowBtn: "取当前时刻",
      clearBtn: "清空",
      copyBtn: "复制",
      copiedBadge: "已复制",
      tsInputLabel: "Unix 时间戳整数",
      tsPlaceholder: "输入整数时间戳（支持 0、负数及纳秒大整数，如 1700000000）…",
      unitLabel: "解释单位",
      unitSec: "秒 (s)",
      unitMs: "毫秒 (ms)",
      unitUs: "微秒 (µs)",
      unitNs: "纳秒 (ns)",
      usedUnitBadge: (unit) => `当前按 ${unit} 解析`,
      suggestedUnitHint: (suggested, applyLabel) => ({
        text: `按数值量级看可能为 ${suggested}（未自动篡改你选定的单位）`,
        btn: applyLabel,
      }),
      subMsPrecisionNote: (subMsText) =>
        `日历时间精确到毫秒，已额外无损保留亚毫秒余数：${subMsText}`,
      dateInputLabel: "日期时间输入",
      datePlaceholder:
        "支持 ISO 8601 带偏移（如 2026-11-18T09:30:00+08:00）或无偏移本地时间（如 2026-11-18 09:30:00.123456789）",
      interpretTzLabel: "无偏移日期的解释时区",
      displayTzLabel: "自选对照 IANA 时区",
      tzPlaceholder: "输入有效 IANA 时区，如 America/New_York、Europe/London、Asia/Tokyo",
      cardUtc: "协调世界时 (UTC)",
      cardLocal: (tz) => `本机系统时区 (${tz})`,
      cardCustom: (tz) => `指定 IANA 时区 (${tz})`,
      isoLabel: "ISO 8601",
      offsetLabel: "UTC 偏移",
      localCivilLabel: "当地日历时间",
      epochSecLabel: "秒 (s)",
      epochMsLabel: "毫秒 (ms)",
      epochUsLabel: "微秒 (µs)",
      epochNsLabel: "纳秒 (ns)",
      precisionTruncatedNote:
        "注：输入含亚秒小数时，低精度单位按向零截断整数输出，完整精度见微秒/纳秒行。",
      emptyPrompt: "输入时间戳或点击“取当前时刻”查看多时区与精确整数换算结果。",
    },
    wordCounterTool: {
      scopeNote:
        "字符数采用 Unicode 字素簇（Grapheme）统计，词数与句数基于 Intl.Segmenter 标准分段（不同编辑器分词口径可能存在差异）。单次输入上限 2 MiB，不记录或持久化任何正文。",
      inputLabel: "待统计正文",
      placeholder: "在此输入或粘贴中文、英文或多语言混合文本…",
      clearBtn: "清空文本",
      copySummaryBtn: "复制统计摘要",
      copiedBadge: "已复制",
      statWords: "词数 (Words)",
      statCharsWithSpaces: "字符（含空白）",
      statCharsNoWhitespace: "字符（不含空白）",
      statSentences: "句子数",
      statParagraphs: "段落数",
      statLines: "行数",
      statUtf8Bytes: "UTF-8 字节",
      statReadingTime: "预计默读时长",
      statSpeakingTime: "预计朗读时长",
      estimateAssumptions:
        "时长为估算值：默读按中文约 350 字/分、西文约 220 词/分估算；朗读按中文约 180 字/分、西文约 140 词/分估算。",
      rulesNote:
        "口径说明：空文本计 0 行 0 段；CRLF 与 LF 统一按换行切分，末尾空行计入物理行数；连续空行分隔的非空文本块计为段落。",
      topWordsTitle: "高频词统计（忽略大小写与常见中英文虚词，前 10 项）",
      topWordsEmpty: "输入包含实词的正文后在此展示词频分布。",
      limitExceeded: (maxMb) => `输入文本超过 ${maxMb} MiB 安全上限，请精简后再统计以防阻塞界面。`,
      formatDuration: (seconds) => {
        if (seconds <= 0) return "0 秒";
        if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
        const mins = Math.floor(seconds / 60);
        const rem = Math.round(seconds % 60);
        return rem > 0 ? `约 ${mins} 分 ${rem} 秒` : `约 ${mins} 分钟`;
      },
    },
    caseConverterTool: {
      scopeNote:
        "支持参考基线全部 12 种大小写与命名风格，按行保留换行边界，输入区保持原文不被覆盖。注：标识符命名转换属于有损格式映射，不承诺可逆还原，亦不执行自然语言翻译或转拼音。",
      inputLabel: "原始文本 / 名称列表（每行一项）",
      outputLabel: "转换结果",
      placeholder: "输入英文标题、句子或代码标识符列表（如 getHTTPResponse、version2Value）…",
      copyBtn: "复制结果",
      copiedBadge: "已复制",
      clearBtn: "清空",
      stylesLabel: "选择目标样式（共 12 种）",
      lineRuleNote:
        "拆分规则：统一识别缩写词边界（HTTPResponse → http + response）、驼峰、数字边界与连续分隔符；Title Case 保留常见英文虚词小写及已知混合大小写专有名词（如 iPhone、macOS、WinKit）。",
      emptyPreview: "—",
      styleNames: {
        uppercase: "UPPERCASE（全大写）",
        lowercase: "lowercase（全小写）",
        title: "Title Case（英文标题）",
        sentence: "Sentence case（句首大写）",
        camel: "camelCase（小驼峰）",
        pascal: "PascalCase（大驼峰）",
        snake: "snake_case（下划线）",
        constant: "CONSTANT_CASE（常量大写）",
        kebab: "kebab-case（短横线）",
        dot: "dot.case（点分隔）",
        alternating: "aLtErNaTiNg（交替大小写）",
        inverse: "iNVERSE（大小写反转）",
      },
    },
    beautifierTool: {
      scopeNote:
        "阶段 1 子集：支持 PNG/JPEG 纯色背景装裱、留白、圆角、阴影与原始/1:1/16:9 原分辨率 PNG 导出（渐变/背景图/系统抓图归阶段 3）。",
      selectImageBtn: "选择图片（PNG / JPEG）…",
      replaceImageBtn: "更换图片…",
      clearImageBtn: "移除图片",
      dropImageHint: "支持从资源管理器直接拖入 .png / .jpg / .jpeg 图片",
      previewLabel: "实时布局预览",
      sourceSizeLabel: "原图尺寸",
      outputSizeLabel: "导出画布尺寸",
      noUpscaleNote:
        "导出时按原图 1:1 真实像素合成，不将缩放预览图当作导出结果，也不无提示拉伸原图。",
      bgColorLabel: "纯色背景",
      customColorLabel: "自定义颜色",
      paddingLabel: "四周留白",
      radiusLabel: "图片圆角",
      shadowLabel: "投影强度",
      aspectLabel: "输出画布比例",
      aspectOriginal: "原始比例",
      aspectSquare: "1 : 1 方形",
      aspectWide: "16 : 9 宽屏",
      exportPngBtn: "导出高清 PNG…",
      exportingBtn: "正在合成导出…",
      exportedSuccess: (path, w, h) => `已导出 PNG（${w} × ${h} px）：${path}`,
      emptyTitle: "导入一张截图或图片开始装裱",
      emptyDesc: "选择本地 PNG 或 JPEG 文件，或将其拖入此处；原图不会被修改。",
      limitHint:
        "安全边界：单图最大 50 MB、边长不超过 8192 px，输出画布不超过 10000 px / 4800 万像素。",
      overwriteConfirmTitle: "目标图片已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖原图）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
    },
    jwtTool: {
      scopeNote:
        "离线解析三段式 JWS/JWT（大整数零损保真，上限 256 KiB）与五段式 JWE 保护头；支持本地 HS256 / HS384 / HS512 原始片段 HMAC 验签（密钥上限 64 KiB；公钥算法仅解码不验签，加密 JWE 仅读取头部）。",
      tokenInputLabel: "JWT / JWS 令牌输入",
      tokenPlaceholder:
        "粘贴三段式 JWT（支持自动识别外层成对引号与 Bearer 前缀，绝不上传或写入历史）",
      sampleHs256Btn: "填入 RFC 示例",
      clearBtn: "清空令牌与密钥",
      envelopeStrippedNote: (bearer, quotes) =>
        `已自动剥离外层包装（${[bearer ? "Bearer 前缀" : "", quotes ? "成对引号" : ""].filter(Boolean).join("、")}），未改动令牌内部字符。`,
      statusSectionLabel: "三项独立核验状态",
      dimStructureLabel: "1. 结构与解码",
      dimSignatureLabel: "2. 签名校验",
      dimTimeLabel: "3. 时间声明核对",
      structEmpty: "等待输入令牌",
      structValidJws: (alg) => `三段式 JWS 解码成功（alg: ${alg}）`,
      structJweEncrypted: "五段式加密 JWE（仅解析保护头，不执行解密）",
      structInvalid: "令牌结构或编码无效",
      jweUnsupportedBody:
        "检测到 5 段式 JWE 加密结构（Protected Header · Encrypted Key · IV · Ciphertext · Tag）。按工具基线范围仅离线展示可读保护头，不支持本地密钥解密。",
      sigUnverified: "签名未验证（输入密钥后校验）",
      sigVerifying: "正在校验 HMAC…",
      sigValid: (alg, keyBytes) => `签名有效（${alg}，密钥 ${keyBytes} 字节）`,
      sigInvalid: "签名无效（HMAC 不匹配）",
      sigAlgMismatch: (headerAlg, expectedAlg) =>
        `算法不匹配（头部 ${headerAlg} ≠ 期望 ${expectedAlg}）`,
      sigUnsignedNone: "未签名令牌（alg=none，无密码学签名）",
      sigUnsupportedAlg: (alg) => `仅解码头部与载荷，不支持公钥/该算法验签（alg: ${alg}）`,
      sigUnsupportedCrit: (crit) => `拒绝验签：含未支持的关键扩展头 crit=${crit}`,
      sigInvalidBase64Key: "密钥 Base64 / Base64url 格式无效",
      nonAuthDisclaimer:
        "说明：HMAC 签名匹配仅证明持有相同共享密钥且原始片段未被篡改，不代表业务权限有效或发行方受信任。",
      remoteKeyHintWarning:
        "安全提示：令牌头部包含 jku / x5u 远程密钥字段；WinKit 严格按离线文本展示，绝不发起任何网络请求。",
      unsecuredNonEmptySigWarning:
        "结构警告：头部声明 alg=none，但第 3 段非空（RFC 7515 要求无签名 JWS 第 3 段必须为空）。",
      precisionNote: "检测到超出 IEEE 754 安全整数范围的数值声明，已按原始字面量无损展示。",
      verifierSectionTitle: "本地 HMAC 验签（原始 header.payload 字节）",
      expectedAlgLabel: "期望验签算法",
      expectedAlgAuto: "按允许列表匹配头部（HS256/384/512）",
      secretModeLabel: "密钥编码模式",
      secretModeUtf8: "UTF-8 原始文本",
      secretModeBase64: "Base64 / Base64url 字节",
      secretInputLabel: "共享密钥（默认遮挡）",
      secretPlaceholderUtf8: "输入 UTF-8 共享密钥以本地校验 HMAC 签名",
      secretPlaceholderBase64: "输入 Base64 或 Base64url 编码密钥",
      showSecretBtn: "显示密钥",
      hideSecretBtn: "隐藏密钥",
      timeActive: "当前处于有效时间窗口内",
      timeExpired: "已过期（当前时刻 ≥ exp）",
      timeNotYetValid: "尚未生效（当前时刻 < nbf）",
      timeNoWindow: "未提供 exp / nbf 有效期边界",
      timeInvalidClaim: "存在非法或越界的时间声明字段",
      evaluatedAtLabel: "核对基准时刻",
      headerSectionTitle: "Header（JOSE 头部 JSON）",
      payloadSectionTitle: "Payload（Claims 载荷 JSON）",
      rawSegmentsSectionTitle: "原始编码片段（验签输入基准）",
      registeredClaimsTitle: "标准注册声明（RFC 7519）",
      copyHeaderJsonBtn: "复制 Header",
      copyPayloadJsonBtn: "复制 Payload",
      copyRawHeaderBtn: "复制原始 Header 段",
      copyRawPayloadBtn: "复制原始 Payload 段",
      copyRawSigBtn: "复制原始签名段",
      copiedBadge: "已复制",
      claimMissing: "未提供该声明",
      claimInvalidType: (raw) => `字段类型不合法（需为 NumericDate 秒数，实际：${raw}）`,
      claimOutOfRange: (raw) => `超出可表示日期范围（原始值：${raw}）`,
      claimZeroEpochBadge: "Unix 纪元零点 (0)",
      claimNames: {
        iss: "iss · 签发方 (Issuer)",
        sub: "sub · 主体 (Subject)",
        aud: "aud · 受众 (Audience)",
        jti: "jti · 令牌 ID (JWT ID)",
        exp: "exp · 过期时间 (Expiration)",
        nbf: "nbf · 生效时间 (Not Before)",
        iat: "iat · 签发时间 (Issued At)",
      },
    },
    diffTool: {
      scopeNote:
        "支持并排与内联逐行差异对比、词/字符级高亮与精确 Unified Diff 导出（单侧上限 4 MiB / 50,000 行；不向用户原文件自动执行补丁）。",
      leftTitle: "左侧原文 (A)",
      rightTitle: "右侧新文 (B)",
      leftPlaceholder: "在此输入或粘贴原文 A，或打开/拖入本地 UTF-8 文本文件…",
      rightPlaceholder: "在此输入或粘贴新文 B，或打开/拖入本地 UTF-8 文本文件…",
      openLeftBtn: "打开左侧…",
      openRightBtn: "打开右侧…",
      swapBtn: "交换 A ↔ B",
      recompareBtn: "重新比较",
      clearBtn: "清空",
      toggleInputsShow: "展开输入编辑区",
      toggleInputsHide: "收起输入编辑区",
      dropSideLabel: "单文件拖放目标",
      dropSideLeft: "导入左侧 A",
      dropSideRight: "导入右侧 B",
      droppedTwoFilesInfo: (leftName, rightName, extraIgnored) =>
        `已按顺序载入两个拖放文件：左侧 A = ${leftName}，右侧 B = ${rightName}${extraIgnored ? "（其余文件已忽略）" : ""}。`,
      viewSideBySide: "并排视图",
      viewInline: "内联视图",
      ignoreWhitespaceLabel: "忽略空白与行尾符",
      ignoreCaseLabel: "忽略大小写",
      prevHunkBtn: "上一处差异",
      nextHunkBtn: "下一处差异",
      hunkIndicator: (current, total) => `差异块 ${current} / ${total}`,
      copyPatchBtn: "复制精确 Unified Diff",
      copiedBadge: "已复制补丁",
      savePatchBtn: "另存 .patch…",
      savedPatchSuccess: (path) => `已保存精确补丁文件：${path}`,
      overwriteConfirmTitle: "目标补丁文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖左侧或右侧源文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
      statusComputing: "正在后台计算差异…",
      statusExactIdentical: (lines) => `两侧内容完全一致（共 ${lines} 行，字节级无差异）。`,
      statusFilteredIdenticalRawDiffers:
        "在当前忽略空白/大小写规则下无可见差异；但原始 A/B 仍存在空白、大小写或换行符差异，仍可复制/另存精确补丁。",
      statusDiffSummary: (hunks, added, deleted) =>
        `共 ${hunks} 处差异块 · 新增 +${added} 行 · 删除 -${deleted} 行`,
      filterPatchNotice:
        "提示：当前对比视图已启用忽略空白/大小写过滤，两侧原文未被修改；复制与另存的 Unified Diff 始终从原始 A/B 生成，可精确从 A 还原 B。",
      fallbackLargeEditNotice:
        "提示：两侧差异跨度超过精细回溯预算（6,000 步），中间段已按分块替换展示，导出的精确补丁仍完整有效。",
      expandContextBtn: (count) => `展开中间隐藏的 ${count} 行未改动上下文`,
      showMoreRowsBtn: (shown, total) => `继续加载后续行（当前已渲染 ${shown} / ${total} 项）`,
      noEofNewlineBadge: "末尾无换行",
      bomBadge: "UTF-8 BOM",
      emptyDiffHint: "两侧均为空文本（0 行）。输入或打开两个文本文件后在此查看行级与词级差异。",
    },
    regexTool: {
      engineBadge: "引擎：ECMAScript / JavaScript RegExp（独立 Worker 隔离）",
      scopeNote:
        "全部编译、匹配与替换均在独立 Web Worker 中执行，主线程设 2,000 ms 超时硬终止（不保留超时前局部匹配）。表达式上限 16,384 UTF-16 代码单元、文本上限 2 MiB、单次收集最多 2,000 处匹配；与参考版 ICU 引擎差异：无 x 自由空白标志，命名捕获替换为 $<name>。",
      patternLabel: "正则表达式 (Pattern)",
      patternPlaceholder: "例如：(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})",
      flagsLabel: "修饰符 (Flags)",
      flagsInputAria: "修饰符字符串",
      testTextLabel: "测试文本（上限 2 MiB，不修改原文件）",
      testTextPlaceholder: "在此输入或打开本地 UTF-8 文本以测试匹配与替换…",
      openTextFileBtn: "打开文本文件…",
      stopWorkerBtn: "中止当前计算",
      clearBtn: "清空",
      enableReplaceLabel: "启用替换预览",
      replacementLabel: "替换模板 (Replacement)",
      replacementPlaceholder: "例如：$<year>/$<month>/$<day>（支持 $&、$1、$<name>、$$）",
      replacementSyntaxHint:
        "JS 替换语法：$1..$99 编号组 · $<name> 命名组 · $& 整段匹配 · $` 前缀 · $' 后缀 · $$ 字面量 $",
      offsetUnitNote:
        "位置口径：偏移为 0 基 UTF-16 代码单元区间 [start, end)；行列为 1 基（UTF-16 列偏移）。",
      statusEmptyPattern: "输入正则表达式后开始匹配。",
      statusRunning: "正在独立 Worker 中执行正则（2000 ms 执行预算）…",
      statusInvalidRegex: (msg) => `非法表达式或修饰符组合：${msg}`,
      statusTimeout: (ms) =>
        `执行已超过 ${ms} ms 安全预算，已强制终止后台 Worker！界面保持正常响应，请简化回溯量词后重试。`,
      statusCancelled: "已取消上一次正则计算。",
      statusWorkerError: (msg) => `后台 Worker 异常：${msg}`,
      statusNoMatch: (ms) => `无匹配项（耗时 ${ms} ms）。`,
      statusMatched: (count, ms, truncated) =>
        `共命中 ${count}${truncated ? "+" : ""} 处匹配（耗时 ${ms} ms）。`,
      matchesTruncatedWarn: (max) => `匹配数量超过单次收集上限（${max} 条），后续匹配已停止收集。`,
      highlightTruncatedWarn: (max) =>
        `为保证界面流畅，高亮视图仅渲染前 ${max} 处匹配，完整已收集项见右侧匹配表。`,
      replacePreviewTruncatedWarn: (shown, full) =>
        `界面预览仅展示前 ${shown.toLocaleString()} 个字符（完整结果共 ${full.toLocaleString()} 个 UTF-16 单元，“复制替换结果”将复制完整文本）。`,
      highlightPaneTitle: "原文匹配高亮预览",
      matchesPaneTitle: "匹配详情与捕获组",
      replacementPaneTitle: "替换结果预览（不改动原文件）",
      copyMatchesBtn: "复制匹配项",
      copyReplacementBtn: "复制完整替换结果",
      copiedBadge: "已复制",
      colMatchNum: "#",
      colMatchText: "匹配文本",
      colUtf16Range: "UTF-16 [起, 止)",
      colLineCol: "行 : 列",
      colCaptures: "编号与命名捕获组",
      zeroLengthBadge: "零宽匹配",
      unmatchedGroupBadge: "未参与匹配",
    },
    unicodeTool: {
      scopeNote: (version) =>
        `基于离线 Unicode ${version} 官方数据库（UAX #44 / #29 / UTS #39）逐码点检查（上限 512 KiB / 50,000 码点）。默认清理保留换行、Tab、组合音标、Emoji ZWJ 与波斯/印地语 ZWNJ 连接符；UTS #39 单码点原型仅作易混提示，不承诺覆盖全部跨语种欺骗文本。`,
      confusableNeutralNote:
        "说明：“可能混淆”依据 UTS #39 视觉原型表提示与 ASCII 字形相近的非 ASCII 字符（如西里尔文 а 与拉丁文 a），不代表恶意内容；多语种正常文本中出现属正常现象。",
      inputLabel: "待检查原始文本（点击字符或表格行可双向定位）",
      inputPlaceholder:
        "粘贴或打开本地 UTF-8 文本，逐码点查看名称、UTF-8 字节、零宽/方向控制与相似字形…",
      openFileBtn: "打开文件…",
      sampleBtn: "填入综合测试样例",
      clearBtn: "清空",
      attentionOnlyLabel: (count) => `仅显示需注意项 (${count})`,
      summaryStats: (cp, utf16, graphemes, bytes) =>
        `${cp} 码点 · ${utf16} UTF-16 单元 · ${graphemes} 字素簇 · ${bytes} UTF-8 字节`,
      tablePaneTitle: "逐码点属性明细（点击任意行在原文中高亮定位）",
      pageInfo: (start, end, total) => `第 ${start}–${end} 项 / 共 ${total} 项`,
      prevPageBtn: "上一页",
      nextPageBtn: "下一页",
      colCpIdx: "码点#",
      colUtf16: "UTF-16",
      colGrapheme: "字素#",
      colHex: "U+XXXX",
      colGlyph: "可视标记",
      colName: "Unicode 官方名称 / 状态",
      colCategoryScript: "类别 · 文字系",
      colUtf8: "UTF-8 字节",
      colFlags: "提示类别",
      flagLabels: {
        bom: "BOM / ZWNBSP",
        zero_width: "零宽格式符",
        joiner_or_variation_selector: "连接符 / 变体选择符",
        bidi_control: "双向控制符",
        special_whitespace: "非常规空白",
        control_char: "控制字符",
        combining_mark: "组合附加符",
        potential_confusable: "可能混淆 (UTS #39)",
        private_or_unassigned: "私用区 / 未分配",
      },
      confusableProtoPrefix: "原型候选",
      sanitizerPaneTitle: "可预览文本清理（原输入保持不变）",
      optRemoveBom: "移除开头与正文中的 BOM (U+FEFF)",
      optRemoveZeroWidth: "移除非连接零宽格式符 (ZWSP / WJ / SHY 等)",
      optNormalizeSpaces: "将非常规空白 (NBSP / 全角空格等) 转为普通空格（保留换行与 Tab）",
      optRemoveControls: "移除异常 C0/C1 控制字符（保留 LF / CR / Tab）",
      optRemoveBidi: "移除双向覆盖与隔离控制符 (RLO / LRI 等，防视觉重排)",
      optRemoveJoiners:
        "移除连接符与变体选择符 (ZWJ / ZWNJ / VS，注意会拆分组合 Emoji 或波斯语词形)",
      optReplaceConfusables: "将 UTS #39 相似字符替换为 ASCII 原型（默认关闭，慎用于非拉丁语种）",
      changesSummary: (count, truncated) =>
        `预览变更：共 ${count}${truncated ? "+" : ""} 处删除或替换`,
      noChangesNote: "当前清理选项下无需修改任何字符。",
      previewLabel: "清理后结果预览",
      copyCleanedBtn: "复制清理结果",
      saveCleanedBtn: "另存清理结果…",
      copiedBadge: "已复制",
      savedSuccess: (path) => `已保存清理后的文本：${path}`,
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖原输入文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
      emptyHint: "输入或打开文本后在此逐码点展示 Unicode 名称、UTF-8 字节序列与清理差异预览。",
    },
    cleanLinksTool: {
      scopeNote: (ruleVersion) =>
        `本地规则库 (${ruleVersion})：离线剥离已知通用与站点专属跟踪参数，解包 Google / Facebook / Instagram / Outlook Safe Links / LinkedIn 跳转包装（最多 5 层，绝不联网访问目标）；保留其余查询原始编码与疑似签名链接。上限 1 MiB / 5,000 行。`,
      inputLabel: "待清理链接（每行一条 HTTP / HTTPS 网址）",
      inputPlaceholder:
        "粘贴单条或多条带跟踪参数的网址（每行一条；非网址行将就地提示原因，不会清空其他有效链接）…",
      readClipboardBtn: "读取剪贴板预览",
      replaceClipboardBtn: "一步净化并写回剪贴板（仅纯链接时替换）",
      sampleBtn: "填入合成示例",
      clearBtn: "清空",
      copyAllBtn: (count) => `复制全部有效结果 (${count})`,
      copySingleBtn: "复制",
      copiedBadge: "已复制",
      rulesSummaryTitle: "规则与保留边界说明",
      rulesSummaryBody:
        "通用规则：utm_*、hsa_*、mtm_*、fbclid、gclid、msclkid、mc_cid/mc_eid、_hsenc/_hsmi、mkt_tok、_ga/_gl 等。站点专属：YouTube/Spotify (si 等)、Instagram (igsh/igshid)、TikTok (_t/_r/share_* 等)、Amazon (pd_rd_*/pf_rd_*/qid/sr/ref_ 等)、X 状态页 (s/t)、LinkedIn、Reddit。id、token、ref、source、q、page 等通用参数默认保留；命中 sig / X-Amz-Signature 等疑似签名特征时整条原样保留。不启动后台剪贴板持续监听。",
      clipboardReadEmpty: "当前系统剪贴板为空或不含可读纯文本。",
      clipboardLoadedPreview: "已读取剪贴板内容至输入区，请核对右侧清理预览后按需复制。",
      clipboardReplacedOk: (changed, total) =>
        `已一步净化并写回剪贴板（共 ${total} 条有效链接，其中 ${changed} 条发生净化变更）。`,
      clipboardKeptNonLinks:
        "剪贴板包含非 HTTP/HTTPS 链接文本，已保持系统剪贴板原样不变（内容已载入供逐行查看）。",
      clipboardLimitExceeded: "剪贴板文本超出单次处理上限（1 MiB / 5,000 行），剪贴板保持不变。",
      statusEmpty: "输入或读取链接后查看参数剥离明细与跳转解包过程。",
      statusLimitBytes: (actual, limit) =>
        `输入体积（${actual.toLocaleString()} 字节）超过 ${limit.toLocaleString()} 字节（1 MiB）上限。`,
      statusLimitLines: (actual, limit) =>
        `输入行数（${actual.toLocaleString()} 行）超过 ${limit.toLocaleString()} 行上限。`,
      statusSummary: (valid, changed, removedParams, unwrapped, invalid) =>
        `有效链接 ${valid} 条（已净化 ${changed} 条 · 移除参数 ${removedParams} 项 · 解包跳转 ${unwrapped} 条）${invalid > 0 ? ` · 无效行 ${invalid} 条` : ""}`,
      resultsPaneTitle: "逐行清理与解包明细",
      cleanedOutputPaneTitle: "有效清理结果汇总",
      linePrefix: (n) => `第 ${n} 行`,
      badgeCleaned: "已净化",
      badgeUnchanged: "无需修改",
      badgePresignedSkipped: (key) => `疑似签名链接 (${key}) · 已原样跳过`,
      badgeInvalid: "无效行",
      removedParamsLabel: "已移除参数：",
      scopeUniversal: "通用",
      scopeSite: "站点专属",
      unwrappedChainLabel: "已解包包装：",
      unwrapStoppedNote: {
        missing_target_param: (provider) =>
          `检测到 ${provider} 域名路径，但缺少目标跳转参数，已保留原链接。`,
        ambiguous_target_param: (provider) =>
          `${provider} 含多个不一致的目标跳转参数，为防误判已保留原链接。`,
        malformed_target_encoding: (provider) =>
          `${provider} 目标参数百分号编码不合法，已保留原包装链接。`,
        non_http_or_invalid_target: (provider) =>
          `${provider} 单层解码后目标并非合法 HTTP/HTTPS 网址，已停止解包并保留当前链接。`,
        target_too_long: (provider) => `${provider} 解包目标超出长度上限，已停止解包。`,
        cycle_detected: (provider) => `检测到 ${provider} 循环嵌套跳转，已停止继续解包。`,
        max_depth_reached: (depth) => `已达最大解包层数上限（${depth} 层），停止继续解包。`,
      },
      invalidReasons: {
        not_http_url:
          "仅支持以 http:// 或 https:// 开头的明确网址（不自动转换普通句子或其它协议）。",
        contains_whitespace_or_control:
          "网址内部包含空格或控制字符，请检查是否多条链接粘连在同一行。",
        url_too_long: "单条链接超过 16,384 UTF-16 代码单元安全上限。",
        malformed_url: "URL 语法或主机名无效。",
      },
      malformedKeyPreservedNote: (count) =>
        `注：有 ${count} 个参数名含非常规百分号序列，已按原始字节保守保留。`,
    },
    loremTool: {
      scopeNote:
        "基于本地固定古典拉丁语词库离线生成占位文本（不调用模型或外部服务）。经典开头计入请求的总词数/句数/段数，HTML <p> 标签不计入正文词数。",
      unitLabel: "生成粒度",
      unitWords: "按词 (Words)",
      unitSentences: "按句 (Sentences)",
      unitParagraphs: "按段 (Paragraphs)",
      countLabel: (min, max) => `数量 (${min}–${max})`,
      formatLabel: "输出格式",
      formatPlain: "纯文本",
      formatHtml: "HTML (<p>)",
      formatMarkdown: "Markdown",
      classicStartLabel: "以经典 Lorem ipsum dolor sit amet… 开头",
      regenerateBtn: "重新生成",
      copyBtn: "复制文本",
      copiedBadge: "已复制",
      clearBtn: "清空",
      outputPaneTitle: "占位文本结果（按纯文本安全展示）",
      statusStats: (words, sentences, paragraphs, chars) =>
        `已生成：${words.toLocaleString()} 词 · ${sentences.toLocaleString()} 句 · ${paragraphs.toLocaleString()} 段 · ${chars.toLocaleString()} 字符`,
      statusCleared: "结果已清空。修改任意选项或点击“重新生成”即可生成新的占位文本。",
      errNonInteger: "请输入有效的正整数数量（不支持空值、负数、0 或小数）。",
      errOutOfRange: (min, max) => `当前粒度数量须在 ${min} 至 ${max.toLocaleString()} 之间。`,
      errBudgetExceeded: (maxChars) =>
        `生成结果超出 ${maxChars.toLocaleString()} 字符安全上限，请调小数量。`,
    },
    passwordTool: {
      scopeNote:
        "普通登录密码与英文词表口令短语（Passphrase）本地生成工具（不含钱包 BIP39 助记词）。全程采用操作系统密码学安全随机源（OS CSPRNG）无偏拒绝采样，默认掩码展示，仅在主动点击复制时写入剪贴板。",
      modePassword: "随机密码 (Password)",
      modePassphrase: "口令短语 (Passphrase)",
      batchCountLabel: "每批条数 (1–50)",
      passwordLengthLabel: "密码长度 (8–128)",
      wordCountLabel: "词数 (3–12)",
      charClassesTitle: "字符类别与约束",
      optUppercase: "大写字母 (A–Z)",
      optLowercase: "小写字母 (a–z)",
      optDigits: "数字 (0–9)",
      optSymbols: "符号 (!@#$%^&*()-_=+[]{};:,.<>?/|~)",
      optExcludeLookAlikes: "排除易混字符 (0, O, o, 1, l, I, |)",
      optRequireEachClass: "每类所选字符至少包含 1 个（有界拒绝采样）",
      passphraseOptionsTitle: "口令短语格式（EFF 7,772 词表，独立有放回抽样）",
      separatorLabel: "词间分隔符",
      sepHyphen: "连字符 (-)",
      sepSpace: "空格 ( )",
      sepDot: "点号 (.)",
      sepUnderscore: "下划线 (_)",
      sepNone: "无分隔符（空）",
      optCapitalize: "词首字母大写",
      optIncludeNumber: "末尾附加两位随机数字 (00–99)",
      generateBtn: "生成",
      regenerateBtn: "重新生成",
      revealBtn: "显示明文",
      hideBtn: "隐藏明文",
      copyBatchBtn: (count) => `复制本批 (${count})`,
      copySingleBtn: "复制",
      copiedBadge: "已复制",
      clearBtn: "清空",
      strengthTitle: "按生成模型估算的熵 / 强度",
      tierLabels: {
        weak: "偏弱 (< 50 bits)",
        fair: "一般 (50–69 bits)",
        strong: "强 (70–99 bits)",
        very_strong: "极强 (≥ 100 bits)",
      },
      bitsExactLabel: (bits) => `约 ${bits.toFixed(2)} bits（生成模型估算）`,
      bitsUpperBoundLabel: (bits) => `生成选择上界：≤ ${bits.toFixed(2)} bits`,
      modelAssumptions: {
        independent_uniform_chars: (poolSize) =>
          `假设说明：从去重后的 ${poolSize} 个有效字符中独立均匀有放回抽取，估算值 = L × log2(${poolSize})。不展示无条件依据的“破解耗时”。`,
        constrained_all_selected_classes: (poolSize, upperBits) =>
          `假设说明：在 ${poolSize} 字符全集上执行均匀有界拒绝采样，仅接受覆盖全部已选类别的候选；已按容斥原理精确扣除缺类组合（无约束上界为 ${upperBits.toFixed(2)} bits）。`,
        independent_words_with_replacement: (dictSize, isUpperBound) =>
          isUpperBound
            ? `假设说明：从 ${dictSize.toLocaleString()} 个纯小写英文词中独立均匀有放回选词（允许自然重复）；因当前为空分隔符且未开启首字母大写，不同复合词序列可能合并为同一字符串，故仅标为生成选择上界。`
            : `假设说明：从 ${dictSize.toLocaleString()} 个纯字母词（EFF Long Wordlist 去连字符子集，CC BY 4.0）中独立均匀有放回选词（允许自然重复）；固定分隔符与确定性大写不增加随机性，末尾随机数字仅计入 100 种等概选择（+6.64 bits）。`,
      },
      memoryPrivacyNote:
        "内存说明：结果仅保存在当前会话内存中，切换工具保持掩码，清空/重新生成立即替换引用，不写入磁盘或历史（注：受运行时管理内存限制，不宣称已完成物理内存安全擦除）。",
      staleBanner:
        "配置已变更，下方列表为旧配置生成结果（已禁用复制以防误用）；请点击“重新生成”获取符合当前配置的结果。",
      emptyPrompt: "设置上方规则后点击“生成”以使用系统安全随机源创建密码或口令短语。",
      resultsPaneTitle: (count, masked) =>
        `本批生成结果（共 ${count} 条 · ${masked ? "已掩码保护" : "明文显示中"}）`,
      errInvalidLength: (min, max) => `密码长度须为 ${min} 至 ${max} 之间的整数。`,
      errInvalidWordCount: (min, max) => `口令短语词数须为 ${min} 至 ${max} 之间的整数。`,
      errInvalidBatchCount: (min, max) => `每批生成条数须为 ${min} 至 ${max} 之间的整数。`,
      errNoCharset: "请至少勾选一种字符类别（大写、小写、数字或符号）。",
      errImpossibleConstraints: "当前密码长度小于所选必含字符类别数量，无法满足约束。",
    },
    csvJsonTool: {
      scopeNote:
        "支持 CSV ↔ JSON 互转及 CSV / JSON → Markdown 表格导出（不含 Markdown 反向解析）。独立 Worker 执行，无损保留超 2^53 大整数、精确小数与前导零；输入上限 8 MiB、输出上限 16 MiB。",
      directionLabel: "转换方向",
      dirCsvToJson: "CSV → JSON",
      dirJsonToCsv: "JSON → CSV",
      dirCsvToMd: "CSV → Markdown",
      dirJsonToMd: "JSON → Markdown",
      delimiterLabel: "分隔符",
      delimAuto: "自动检测",
      delimComma: "逗号 (,)",
      delimSemicolon: "分号 (;)",
      delimTab: "Tab",
      firstRowHeaders: "首行为表头",
      detectTypes: "显式类型识别",
      emptyCellsAsNull: "空单元格转 null",
      formulaProtection: "电子表格公式保护",
      advancedSummaryTitle: "高级结构映射、嵌套展开与导出规则",
      headerPolicyLabel: "空/重复表头",
      headerPolicyError: "默认报错防覆盖",
      headerPolicyRename: "自动重命名并提示",
      raggedPolicyLabel: "列数不一致行",
      raggedPolicyError: "精确定位报错",
      raggedPolicyPad: "补齐短行并保留超长列",
      arrayModeLabel: "简单标量数组",
      arrayModeSemicolon: "分号连接（兼容模式）",
      arrayModeJson: "紧凑 JSON 保真",
      pathPolicyLabel: "点号键路径冲突",
      pathPolicyError: "报错防覆盖",
      pathPolicyBracket: "方括号转义区分",
      csvEolLabel: "CSV 行尾符",
      csvBomLabel: "附加 UTF-8 BOM",
      mappingRulesNote:
        "规则说明：默认将 CSV 单元格原样保留为字符串；开启类型识别后仅转换无空白包裹的标准 JSON 数值、true/false 与 null（前导零编号如 00123 仍保留字符串）。JSON → CSV 将 null/缺失字段输出为空单元格，Markdown 将单元格内换行映射为 <br> 并转义 \\ 与 |。CSV 无法天然保留全部 JSON 类型，不承诺任意往返无损。",
      openFileBtn: "打开文件…",
      sampleBtn: "填入保真示例",
      cancelWorkerBtn: "取消转换",
      copyBtn: "复制完整结果",
      copiedBadge: "已复制",
      saveBtn: "另存为…",
      clearBtn: "清空",
      viewTextTab: "结果文本",
      viewTableTab: "表格预览",
      inputPaneTitle: (fileName) =>
        fileName ? `输入源（${fileName}）` : "输入（支持拖入 .csv / .tsv / .json）",
      outputPaneTitle: "转换结果（复制与另存始终导出完整输出）",
      csvPlaceholder:
        "粘贴 CSV / TSV 文本，或打开 / 拖入本地 UTF-8 文件（支持字段内引号、转义引号与多行单元格）…",
      jsonPlaceholder:
        "粘贴 JSON 对象数组 [{...}]、行数组 [[...]] 或单对象，或打开 / 拖入本地 .json 文件…",
      statusEmpty: "输入或导入 CSV / TSV / JSON 数据后自动在后台转换。",
      statusRunning: "正在后台 Worker 中解析与转换…",
      statusCancelled: "已取消上一次转换任务。",
      statusOk: (rows, cols) =>
        `转换完成：${rows.toLocaleString()} 行 × ${cols.toLocaleString()} 列`,
      detectedDelimiterBadge: (delimName, ambiguous) =>
        ambiguous
          ? `自动检测存疑（暂按 ${delimName} 解析，建议手动指定）`
          : `已检测分隔符：${delimName}`,
      statusErrorLoc: (msg, physicalLine, col, recordNum) => {
        const parts: string[] = [];
        if (recordNum !== undefined) parts.push(`记录 #${recordNum}`);
        if (physicalLine !== undefined) parts.push(`物理第 ${physicalLine} 行`);
        if (col !== undefined) parts.push(`第 ${col} 列`);
        return parts.length > 0 ? `转换错误（${parts.join("，")}）：${msg}` : `转换错误：${msg}`;
      },
      previewTruncatedNote: (shownChars, fullChars) =>
        `文本预览仅展示前 ${shownChars.toLocaleString()} 字符（完整输出共 ${fullChars.toLocaleString()} 字符，“复制完整结果”与“另存为”将导出全部数据）。`,
      tableTruncatedNote: (shownRows, totalRows, shownCols, totalCols) =>
        `表格视图仅渲染前 ${shownRows}/${totalRows} 行、前 ${shownCols}/${totalCols} 列。`,
      formulaDetectedWarn: (count) =>
        `检测到 ${count} 个以 = / + / @ / 非纯数字 - / 控制符开头的单元格（当前未启用公式保护，导出保持原始字符不变；双引号包裹本身无法阻止电子表格执行公式）。`,
      formulaProtectedInfo: (count) =>
        `已为 ${count} 个疑似公式文本前置单引号 '（纯负数值如 -42.5 未被改动；注意前置 ' 会改变首字符，且不同表格软件二次保存行为可能存在差异）。`,
      formulaPreviewHeading: "公式保护变更预览（前 5 项）：",
      renamedHeadersNotice: (items) => `已自动重命名空或重复表头：${items}`,
      raggedAdjustedNotice: (padded, extended) =>
        `已按显式规则处理不一致行：补齐短行 ${padded} 行，扩展超长列 ${extended} 列。`,
      ambiguousArrayNotice: (count) =>
        `提示：有 ${count} 处标量数组为空或含分号 / null / 空串，分号连接在反向还原时可能存在歧义；如需严格区分可在高级规则切换为“紧凑 JSON 保真”。`,
      depthCappedNotice: (count, maxDepth) =>
        `有 ${count} 处嵌套对象达到最大展开深度（${maxDepth} 层），已保留为紧凑 JSON 单元格。`,
      singleObjectNotice: "输入根为单个 JSON 对象，已按 1 行记录转换。",
      savedSuccess: (path, bytes) =>
        `已安全保存完整结果（${bytes.toLocaleString()} 字节）：${path}`,
      saveAbortedInputChanged:
        "输入或转换选项在另存对话框打开期间已变更，本次保存已取消以避免混用旧内容。",
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖原输入文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
    },
    coordinateTool: {
      offlineBadge: "WGS 84 · 离线",
      scopeNote:
        "支持二维 WGS 84 地理坐标解析、8 种标准格式导出、参考椭球测地线距离与有限批量转换（纯离线计算，不含在线底图、地址检索或定位）。",
      tabSingle: "坐标转换",
      tabDistance: "两点测距",
      tabBatch: "批量转换",
      modePaste: "单框表达式 / 链接",
      modeSeparate: "独立纬经度输入",
      plainOrderLabel: "无方向标签文本顺序",
      orderLatLon: "纬度, 经度",
      orderLonLat: "经度, 纬度",
      singleInputLabel: "坐标表达式或地图坐标链接（上限 16 KiB）",
      singlePlaceholder:
        "粘贴 DD (37.8197, -122.4786)、DMS (37°49′10.92″N 122°28′42.96″W)、GeoJSON Point、WKT POINT、geo: 或 Apple / Google 坐标链接…",
      latFieldLabel: "纬度 Latitude [-90°, 90°]",
      lonFieldLabel: "经度 Longitude [-180°, 180°]",
      latPlaceholder: "例如 37.8197 或 37°49′10.92″N",
      lonPlaceholder: "例如 -122.4786 或 122°28′42.96″W",
      ddDecLabel: "十进制度位数 (0–8)",
      dmDecLabel: "分小数位 (0–4)",
      dmsDecLabel: "秒小数位 (0–4)",
      precisionHint:
        "显示位数仅控制格式化舍入（含分秒进位），不代表实际定位精度，也不会覆盖未舍入内部坐标或测距输入。",
      sampleBtn: "填入示例",
      clearBtn: "清空",
      sendToABtn: "填入测距起点 A",
      sendToBBtn: "填入测距终点 B",
      detectedBadge: (fmt, order) => `识别格式：${fmt} · 轴序：${order}`,
      detectedFormatNames: {
        separate_fields: "独立纬经度字段",
        dd: "DD 十进制度",
        dm: "DM 度与十进制分",
        dms: "DMS 度分秒",
        geojson_point: "GeoJSON Point",
        wkt_point: "WKT POINT",
        geo_uri: "geo: URI",
        apple_maps_url: "Apple Maps 坐标链接",
        google_maps_url: "Google Maps 坐标链接",
      },
      axisOrderNames: {
        lat_lon: "纬度在前 (Lat, Lon)",
        lon_lat: "经度在前 (Lon, Lat)",
        hemisphere_tagged: "按 N/S/E/W 半球确定",
      },
      outputsPaneTitle: "八种 WGS 84 标准表示（点击仅复制文本，不打开外部网页）",
      emptySinglePrompt: "输入或粘贴有效二维 WGS 84 坐标后生成八种标准格式。",
      formatLabels: {
        dd: "DD 十进制度",
        dms: "DMS 度分秒",
        dm: "DM 十进制分",
        geojson: "GeoJSON Point",
        wkt: "WKT Point",
        geo_uri: "geo: URI",
        apple_maps: "Apple Maps 链接",
        google_maps: "Google Maps 链接",
      },
      formatMeta: {
        dd: "纬度, 经度",
        dms: "度°分′秒″N/S E/W",
        dm: "度°分′N/S E/W",
        geojson: "RFC 7946 [经度, 纬度]",
        wkt: "POINT (经度 纬度) · 按 WGS 84 约定",
        geo_uri: "RFC 5870 geo:纬度,经度",
        apple_maps: "coordinate=纬度,经度",
        google_maps: "api=1&query=纬度%2C经度",
      },
      copyBtn: "复制",
      copiedBadge: "已复制",
      pointATitle: "起点 A",
      pointBTitle: "终点 B",
      pointPlaceholder: "输入 DD / DMS / DM / GeoJSON / WKT / geo: / 坐标链接…",
      fillFromCurrentBtn: "用当前转换点填入",
      swapPointsBtn: "交换 A ↔ B",
      sampleAntipodalBtn: "近对跖点示例",
      sampleDatelineBtn: "跨日界线示例",
      pointAErrorPrefix: (msg) => `起点 A 错误：${msg}`,
      pointBErrorPrefix: (msg) => `终点 B 错误：${msg}`,
      distanceResultTitle: "WGS 84 椭球逆测地线距离",
      distanceEmptyPrompt: "分别输入起点 A 与终点 B 坐标后计算参考椭球表面最短距离。",
      unitKilometers: "千米 (km)",
      unitMeters: "米 (m)",
      unitMiles: "英里 (mi)",
      distanceModelNote:
        "计算模型：WGS 84 参考椭球（a = 6378137 m, f = 1/298.257223563）表面最短测地线距离（GeographicLib Karney 算法），非驾车/步行路线距离或含高程的三维距离。",
      batchInputTitle: (fileName) =>
        fileName ? `批量源（${fileName}）` : "每行一条坐标表达式（上限 1 MiB / 5,000 行）",
      batchPlaceholder:
        "每行粘贴一条 DD、DMS、DM、单行 GeoJSON Point、WKT POINT、geo: 或官方坐标链接（多行格式化 GeoJSON 请使用“坐标转换”单点视图；不支持地址查询）…",
      batchOutputFormatLabel: "目标格式",
      batchCsvScopeLabel: "CSV 导出行范围",
      batchCsvScopeAll: "全部记录（含失败原因，推荐）",
      batchCsvScopeValid: "仅成功记录",
      batchFormulaProtection: "电子表格公式保护",
      openBatchFileBtn: "导入文本…",
      cancelBatchBtn: "取消转换",
      copyValidBtn: (count) => `复制有效结果 (${count})`,
      exportCsvBtn: "保存 CSV…",
      batchStatusEmpty: "粘贴或导入每行一条坐标列表后自动在后台 Worker 中解析。",
      batchStatusRunning: "正在后台 Worker 中批量解析与格式化…",
      batchStatusCancelled: "已取消上一次批量转换。",
      batchStatusSummary: (valid, errors, skippedBlank) =>
        `解析完成：成功 ${valid.toLocaleString()} 行 · 失败 ${errors.toLocaleString()} 行` +
        (skippedBlank > 0 ? ` · 跳过空行 ${skippedBlank.toLocaleString()} 行（源行号保留）` : ""),
      batchPreviewTruncated: (shown, total) =>
        `预览仅显示前 ${shown.toLocaleString()} / ${total.toLocaleString()} 条非空记录；复制与保存 CSV 将输出完整结果（UTF-8 上限 8 MiB）。`,
      batchScopeRuleNote:
        "说明：仅离线解析二维 WGS 84 坐标与坐标链接，不执行地址地理编码或反查；空行自动跳过且不改变后续源行号。",
      colLine: "源行号",
      colRaw: "原始内容",
      colStatus: "状态",
      colLat: "纬度",
      colLon: "经度",
      colResultOrError: "转换结果 / 错误原因",
      badgeOk: "成功",
      badgeErr: "失败",
      savedCsvSuccess: (path, bytes) =>
        `已安全保存批量坐标 CSV（${bytes.toLocaleString()} 字节）：${path}`,
      saveAbortedChanged:
        "批量输入或导出选项在另存对话框打开期间已变更，本次保存已取消以避免输出旧批次。",
      overwriteConfirmTitle: "目标文件已存在",
      overwriteConfirmBody: (path) =>
        `路径 "${path}" 已存在同名文件，是否确认覆盖（绝不允许覆盖原导入文件）？`,
      overwriteConfirmAccept: "确认覆盖",
      cancel: "取消",
    },
  },
  "en-US": {
    appName: "WinKit",
    nav: {
      home: "All Tools",
      favorites: "Favorites",
      recent: "Recent",
      pdfReader: "PDF Quick Preview",
      settings: "Settings",
      availableToolsHeading: "Available Tools",
    },
    categories: {
      all: "All Categories",
      pdf: "Docs & PDF",
      video: "Video",
      audio: "Audio",
      developer: "Developer",
      text: "Text & Speech",
      image: "Images",
      file: "Files",
    },
    topbar: {
      searchPlaceholder: "Search tools…",
      searchShortcutHint: "Ctrl+K",
      runningTasksCount: (count) => `${count} task${count === 1 ? "" : "s"} running`,
      themeToggleLabel: "Switch light/dark theme",
      languageToggleLabel: "Switch display language",
    },
    home: {
      titleAll: "Available Tools",
      titleFavorites: "Favorites",
      titleRecent: "Recently Used",
      subtitleAvailable: (count) =>
        `${count} local desktop tool${count === 1 ? "" : "s"} ready — all processing runs offline on your PC`,
      scopeFull: "Full",
      scopePartial: "Partial",
      openTool: "Open",
      favoriteAdd: "Add to favorites",
      favoriteRemove: "Remove from favorites",
      emptySearch: "No available tools match your current search.",
      emptyFavorites:
        "No favorite tools yet. Click the star button on any tool row to pin it here.",
      emptyRecent: "No recently opened tools yet.",
      emptyRegistry: "No tools registered in this build yet.",
      clearSearch: "Clear filters",
      baselineFooter:
        "Only verified, working tools are listed in the app; planned tools are tracked in docs/PARITY_MATRIX.md.",
    },
    settings: {
      title: "Settings",
      subtitle: "Appearance, language, and local privacy controls",
      appearanceSection: "Appearance",
      themeLabel: "Theme Mode",
      themeLight: "Light (Default)",
      themeDark: "Dark",
      themeSystem: "Follow System",
      languageSection: "Language",
      languageLabel: "Display Language",
      langZh: "简体中文",
      langEn: "English",
      privacySection: "Session State & Local Privacy",
      privacySessionNote:
        "Active tool inputs and parameters are kept in process memory while switching tools and cleared when WinKit exits. User text, file contents, keys, and tokens are never persisted to disk by default.",
      privacyLocalNote:
        "Only theme, language, favorites, and recent tool IDs are stored locally. Zero telemetry, accounts, or cloud calls.",
      clearRecentButton: "Clear Recent History",
      clearRecentDone: "Recent tool history cleared",
      resetPrefsButton: "Reset Preferences",
      resetPrefsDone: "Appearance and language reset to defaults",
      runtimeSection: "Runtime Environment",
    },
    closeGuard: {
      title: "Active Local Task in Progress",
      recordingTitle: "Local Recording in Progress",
      drainingTitle: "Finishing Safely Before Exit…",
      errorTitle: "Unable to Complete Exit",
      body: (count, writeCount) =>
        writeCount > 0
          ? `${count} local task${count === 1 ? " is" : "s are"} still active (including ${writeCount} file-write commit step${writeCount === 1 ? "" : "s"}). WinKit does not run in the system tray; exiting will cancel interruptible tasks and wait for active file writes to finish safely.`
          : `${count} local task${count === 1 ? " is" : "s are"} currently running. WinKit does not continue in the system tray after closing; exiting now will cancel unfinished work and close once file handles are released.`,
      recordingBody:
        "A local audio or screen recording is still active. You can stay in WinKit to keep recording, stop and preserve what has been recorded so you can review or save it, or discard it and exit.",
      bodyFinished:
        "Active background tasks have finished. You can exit WinKit immediately or stay in your workspace.",
      drainingBody:
        "Stopping active tasks, completing atomic file cleanup, and releasing file handles…",
      timeoutBody: (remaining) =>
        `Timed out waiting for tasks to stop (still active: ${remaining}). WinKit kept the window open to avoid corrupting files; you can retry exiting or return to the workspace (cancelled tasks are not resumed).`,
      stayButton: "Stay in WinKit",
      stopAndKeepButton: "Stop & Keep Recording",
      quitAnywayButton: "Cancel Task & Exit",
      discardAndQuitButton: "Discard & Exit",
      exitNowButton: "Exit Now",
      retryQuitButton: "Retry Exit",
    },
    errors: {
      APP_SHUTTING_DOWN: "WinKit is currently shutting down and cannot start new tasks.",
      FILE_NOT_FOUND: "The selected file or folder could not be found.",
      IS_DIRECTORY: "The selected path is a folder rather than a file.",
      SAME_INPUT_AND_OUTPUT: "Output path cannot overwrite the original source file.",
      TARGET_ALREADY_EXISTS: "A file already exists at the destination path.",
      PERMISSION_DENIED: "Permission denied or destination directory is read-only.",
      FILE_LOCKED: "The file is currently locked by another process.",
      FILE_MODIFIED_DURING_READ:
        "The file size or modification timestamp changed while reading; digest aborted.",
      DISK_FULL: "Insufficient disk space on the target drive.",
      SIZE_LIMIT_EXCEEDED:
        "Input size, estimated output, or canvas dimensions exceed safety limits.",
      DECODE_FAILED: "Unable to decode encoded payload or image format.",
      MODEL_MISSING:
        "Bundled offline face detection model was not found in the installation folder.",
      MODEL_INVALID:
        "Bundled face detection model integrity check failed. Please reinstall WinKit.",
      MODEL_LOAD_FAILED: "Failed to load local offline face detection model.",
      INFERENCE_FAILED: "Local face detection inference failed.",
      MEDIA_TOOLS_MISSING:
        "Local FFmpeg / ffprobe media components are not configured yet. Set them up first.",
      MEDIA_TOOLS_INVALID: "FFmpeg / ffprobe verification failed in the selected directory.",
      YTDLP_MISSING:
        "yt-dlp is not configured yet. Web video pages and adaptive manifests require yt-dlp (direct media links work without it).",
      YTDLP_INVALID: "The selected yt-dlp binary failed verification.",
      LOGIN_REQUIRED:
        "This link requires sign-in, cookies, or account access and cannot be downloaded anonymously.",
      AGE_RESTRICTED: "This video is age-restricted and requires account verification.",
      GEO_BLOCKED: "This content is restricted or unavailable in your region.",
      DRM_PROTECTED: "This content is DRM-protected and cannot be downloaded.",
      ACCESS_FORBIDDEN: "Access was denied by the remote server (HTTP 403).",
      NOT_FOUND: "The requested video or media URL was not found or has been removed (HTTP 404).",
      JS_RUNTIME_REQUIRED:
        "This site requires an external JavaScript runtime (Deno or Node.js) for yt-dlp challenge solving.",
      UNSUPPORTED_URL: "This URL is not a supported video page or contains no downloadable stream.",
      NETWORK_ERROR: "Network transfer was interrupted or timed out. You can retry.",
      DOWNLOAD_FAILED:
        "Download failed or was interrupted by the remote server. Check details or retry.",
      CHECKSUM_MISMATCH:
        "Downloaded media package failed SHA-256 integrity verification and was discarded.",
      MEDIA_PROCESS_FAILED: "Local media engine process failed.",
      MIC_PERMISSION_DENIED:
        "Windows blocked microphone access. Enable microphone access for desktop apps in Windows Settings → Privacy & security → Microphone, then retry.",
      NO_MICROPHONE_AVAILABLE:
        "No active microphone device was found. Connect or enable an input device and refresh.",
      AUDIO_DEVICE_IN_USE:
        "The selected audio device is locked in exclusive mode by another application.",
      AUDIO_DEVICE_DISCONNECTED: "The selected audio device was disconnected or disabled.",
      AUDIO_DEVICE_NOT_FOUND:
        "The selected audio device is no longer available. Refresh the list and select another device.",
      EMPTY_RECORDING: "No audio frames were captured before stopping.",
      PDF_PASSWORD_REQUIRED:
        "This PDF requires an open password. Use PDF Decrypt (P16) with the known password to save an unlocked copy first.",
      PDF_WRONG_PASSWORD:
        "The password is incorrect. Check letter case, leading/trailing spaces, and keyboard layout.",
      PDF_NOT_ENCRYPTED: "This PDF is not encrypted and does not require decryption.",
      PDF_ALREADY_ENCRYPTED:
        "This PDF is already encrypted. Remove existing protection with PDF Decrypt (P16) before re-encrypting.",
      PDF_UNSUPPORTED_SECURITY:
        "This PDF uses an unsupported security handler (such as certificate or DRM encryption) and cannot be unlocked by password.",
      PDF_CORRUPT_OR_INVALID:
        "This file is not a valid PDF document or its structure is corrupted.",
      PDF_PAGE_ERROR: "PDF page data is missing or unreadable.",
      PDF_RENDER_FAILED: "Failed to render PDF page. Try a smaller zoom or check the file.",
      PDF_ENGINE_MISSING:
        "Bundled offline PDF engine (pdfium.dll) is missing. Please reinstall WinKit.",
      PDF_ENGINE_INVALID:
        "Bundled offline PDF engine failed integrity verification. Please reinstall WinKit.",
      PDF_ENGINE_LOAD_FAILED: "Failed to load the bundled offline PDF engine.",
      PDF_QPDF_UNAVAILABLE:
        "Bundled offline PDF security engine (qpdf30.dll) is missing. Please reinstall WinKit.",
      PDF_QPDF_INVALID:
        "Bundled offline PDF security engine failed integrity verification. Please reinstall WinKit.",
      PDF_ENCRYPT_VERIFY_FAILED:
        "Independent post-encryption verification failed. No final output file was written.",
      PDF_DECRYPT_VERIFY_FAILED:
        "Independent post-decryption verification failed (output could not be opened without a password). No final output file was written.",
      PDF_MARKDOWN_ENGINE_MISSING:
        "Microsoft Edge (msedge.exe) was not found in standard Windows directories, so offline vector PDF printing cannot run.",
      PDF_WORKER_TIMEOUT:
        "The isolated PDF worker timed out and was terminated safely. The main window remains unaffected.",
      PDF_WORKER_CRASHED:
        "Isolated PDF worker exited unexpectedly (the file may be corrupted). The main window remains safe.",
      PDF_WORKER_ERROR: "Isolated PDF worker communication error. Please retry.",
      OCR_ENGINE_MISSING:
        "The bundled offline OCR runtime or RapidOCR models are missing. Please reinstall WinKit.",
      OCR_ENGINE_LOAD_FAILED:
        "Failed to load the bundled offline OCR runtime or models. Verify the installation folder.",
      OCR_INFERENCE_FAILED:
        "Local offline OCR inference failed. Please verify the image or scanned PDF is intact.",
      OCR_WORKER_TIMEOUT:
        "The isolated OCR worker timed out and was terminated safely. Try lowering PDF DPI or image size.",
      OCR_WORKER_CRASHED:
        "Isolated OCR worker exited unexpectedly. Your source files remain untouched.",
      OCR_WORKER_ERROR: "Isolated OCR worker communication error. Please retry.",
      ASR_MODEL_MISSING:
        "The offline speech model (SenseVoiceSmall INT8 + Silero VAD v5) is not installed yet. Click Download above or select a local model folder.",
      ASR_MODEL_INVALID:
        "Offline speech model files are incomplete or invalid. Please re-download or verify the folder.",
      ASR_ENGINE_LOAD_FAILED:
        "Failed to load the offline speech model. Check model file integrity and available memory.",
      ASR_INFERENCE_FAILED:
        "Offline speech recognition inference failed. Verify the audio/video file is intact.",
      ASR_WORKER_TIMEOUT:
        "The isolated transcription worker made no progress and was terminated safely. Please retry.",
      ASR_WORKER_CRASHED:
        "Isolated transcription worker exited unexpectedly. Your source media remains untouched.",
      ASR_WORKER_ERROR: "Isolated transcription worker communication error. Please retry.",
      MATTING_MODEL_MISSING:
        "The offline background-removal model (BiRefNet_lite 512 FP16) is not installed yet. Click Download above or select a local model folder.",
      MATTING_ENGINE_LOAD_FAILED:
        "Failed to load the offline cutout model. Check model integrity and available memory.",
      MATTING_INFERENCE_FAILED:
        "Offline background-removal inference failed. Verify the image file is intact and retry.",
      MATTING_WORKER_TIMEOUT:
        "The isolated background-removal worker timed out and was safely terminated. Please retry.",
      MATTING_WORKER_CRASHED:
        "Isolated background-removal worker exited unexpectedly. Your source image remains untouched.",
      MATTING_WORKER_ERROR: "Isolated background-removal worker communication error. Please retry.",
      MATTING_RESULT_EXPIRED:
        "The in-memory cutout result expired or was cleared. Please run background removal again.",
      ORT_RUNTIME_MISSING:
        "The bundled ONNX Runtime (onnxruntime.dll) is missing. Please reinstall WinKit.",
      PDF_WRITE_FAILED: "Failed to write output PDF file. Check disk space and folder permissions.",
      TASK_CANCELLED: "Operation cancelled.",
      INVALID_PARAMETER: "Invalid input parameter or file path.",
      FALLBACK: "An unexpected local error occurred.",
    },
    jsonTool: {
      inputLabel: "JSON Input",
      outputLabel: "Formatted / Validated Output",
      placeholder:
        "Paste or type JSON here (objects, arrays, or valid scalars), or drop a local .json file",
      formatBtn: "Format",
      minifyBtn: "Minify",
      validateBtn: "Validate Only",
      openFileBtn: "Open File…",
      saveFileBtn: "Save As…",
      copyBtn: "Copy Output",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      indentLabel: "Indentation",
      indent2: "2 Spaces",
      indent4: "4 Spaces",
      indentTab: "Tab",
      sortKeysLabel: "Sort keys alphabetically",
      statusEmpty: "Waiting for JSON input",
      statusValid: (kind) => `Valid JSON (root: ${kind})`,
      statusInvalid: "Invalid JSON syntax",
      locateErrorBtn: "Jump to Error",
      lineColLabel: (line, col) => `Line ${line}, Column ${col}`,
      precisionNotice:
        "Detected numbers outside IEEE-754 safe integer bounds or with exact trailing decimals; preserved losslessly as raw lexical tokens.",
      duplicateKeyNotice: (count) =>
        `Detected ${count} duplicate object key${count === 1 ? "" : "s"}; preserved without silent overwriting.`,
      dropHint: "Release to load local JSON file",
      savedSuccess: (path) => `Saved to: ${path}`,
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace this output file (original source file remains untouched)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
    },
    hashTool: {
      modeText: "UTF-8 Text",
      modeFile: "Local Files (Batch)",
      algorithmsLabel: "Algorithms",
      scopeNote:
        "Single-pass streaming MD5, SHA-1, SHA-256, SHA-384, and SHA-512 checksums for text and up to 1,000 local files (non-recursive; pause & resume incomplete files within this session).",
      compatNote:
        "For compatibility checksums only; not suitable for password storage, digital signatures, or origin authentication",
      textInputLabel: "Input Text",
      textPlaceholder: "Type or paste text to hash…",
      exactBytesNote:
        "Hashed as exact UTF-8 bytes: all leading/trailing spaces, tabs, and line breaks are preserved with no implicit trimming.",
      byteCount: (bytes) => `${bytes.toLocaleString()} UTF-8 bytes`,
      selectFileBtn: "Choose Files…",
      dropFileHint:
        "Select or drop multiple files from File Explorer (up to 1,000 files per batch; single 256 KiB streaming pass per file)",
      selectedFileLabel: "Selected File",
      fileSizeLabel: "File Size",
      computeBtn: "Recompute",
      recomputeWithNewAlgsBtn: "Recompute Batch with Selected Algorithms",
      cancelBtn: "Cancel Batch",
      resumeIncompleteBtn: (count) => `Resume Incomplete (${count})`,
      retryFailedBtn: (count) => `Retry Failed (${count})`,
      saveCsvBtn: "Save CSV…",
      formulaProtectionLabel: "CSV formula protection",
      uppercaseLabel: "Uppercase hex",
      digestLabel: "Computed Digests",
      copyBtn: "Copy",
      copyAllBtn: "Copy All",
      copyBatchBtn: (count) => `Copy Batch Digests (${count})`,
      copiedBadge: "Copied",
      clearBtn: "Clear",
      staleNotice:
        "Toolbar algorithm selection differs from this batch's frozen snapshot (results below show the batch's actual computed algorithms). Click Recompute Batch to include new algorithms.",
      batchAlgSnapshotLabel: (algs) => `Batch snapshot: ${algs}`,
      batchOverflowNotice: (limit, skipped) =>
        `Batch limit is ${limit.toLocaleString()} files: accepted the first ${limit.toLocaleString()} items and skipped ${skipped.toLocaleString()} excess file(s). Please run excess files in a separate batch.`,
      batchResumeRuleNote:
        "Resumable in this session: completed file digests are kept while incomplete files are re-read from byte 0 (digest internal state is not persisted across restarts).",
      batchSummaryCounts: (total, done, running, pending, errors, cancelled) =>
        `${total} total · ${done} done · ${running} reading · ${pending} queued · ${errors} failed · ${cancelled} cancelled`,
      filterAll: "All",
      filterIncomplete: "Queued / Cancelled",
      filterError: "Failed",
      filterCompleted: "Completed",
      pageInfo: (start, end, total) => `Items ${start}–${end} of ${total}`,
      prevPageBtn: "Prev",
      nextPageBtn: "Next",
      itemStatusLabels: {
        pending: "Queued",
        running: "Reading",
        completed: "Done",
        error: "Failed",
        cancelled: "Cancelled",
      },
      compareRowBadges: {
        match: "Match",
        mismatch: "Mismatch",
        uncomputed: "Uncomputed",
        ambiguous: "Ambiguous",
        invalid: "Invalid",
      },
      emptyDigestsHint:
        "Enter text or select/drop local files to view digests and expected checksum comparison for the selected item.",
      compareLabel: "Compare Expected Digest (Bound to Current Item, Optional)",
      comparePlaceholder:
        "Paste expected digest (grouped SHA-256, md5:/sha256: prefixes, standard two-space / *filename shasum, colons)",
      compareIdle:
        "Enter an expected hex digest to verify equality (hex length suggests a candidate algorithm only and does not authenticate file origin)",
      compareInvalidFormat:
        "Invalid expected digest: must contain 32 (MD5), 40 (SHA-1), 64 (SHA-256), 96 (SHA-384), or 128 (SHA-512) hex characters",
      comparePrefixMismatch:
        "Declared algorithm prefix contradicts digest hex length (e.g. SHA-256 prefix with a 32-hex digest).",
      compareAmbiguousFormat:
        "Ambiguous expected digest: contains a valid-length hex prefix plus trailing tokens that could be either grouped hex or a non-standard filename. Paste the digest alone, add an explicit prefix (e.g. SHA-256:), or use standard shasum format (two spaces or *filename).",
      compareUncomputedCandidate: (alg, hexLen) =>
        `Hex length (${hexLen} chars) corresponds to candidate algorithm ${alg}, which was not computed for this item — select ${alg} and recompute to compare`,
      compareMatch: (alg, hexLen) => `Match: equals computed ${alg} (${hexLen}-hex) digest`,
      compareMismatch: (alg, hexLen) =>
        `Mismatch: does not match computed ${alg} (${hexLen}-hex) digest`,
      statusIdle: "Ready",
      statusStale: "Algorithms changed",
      statusRunning: (pct) => `Streaming single pass (${pct})…`,
      statusCompleted: (count) => `${count} digest${count === 1 ? "" : "s"} ready`,
      statusCancelled: "Cancelled (incomplete items can be resumed in this session)",
      statusError: "Hash computation failed",
      savedCsvSuccess: (path, bytes) =>
        `Saved batch hash CSV (${bytes.toLocaleString()} bytes): ${path}`,
      saveAbortedChanged:
        "Batch items or export options changed while the Save dialog was open; save cancelled to prevent writing stale data.",
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace it (no source file in the batch can ever be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
    },
    codecTool: {
      scopeNote:
        "Standard/URL-safe Base64, Hex, and 8-bit Binary encoding & decoding (Base64 is data encoding, not encryption). Limits: 2 MiB text, 8 MiB raw file (2 MiB for Binary bit encoding).",
      modeText: "UTF-8 Text",
      modeFile: "Local File (Raw Bytes)",
      opEncode: "Encode",
      opDecode: "Decode",
      formatStdB64: "Standard Base64",
      formatUrlB64: "URL-Safe Base64",
      formatHex: "Hex (Base16)",
      formatBinary: "Binary (8-bit)",
      paddingLabel: "Pad with '='",
      strictPaddingDecodeLabel: "Require '=' padding",
      wrapLabel: "Line wrap",
      wrapNone: "No wrap",
      wrap64: "64 cols",
      wrap76: "76 cols",
      ignoreWsLabel: "Ignore whitespace",
      upperHexLabel: "Uppercase Hex",
      groupBitsLabel: "Space-group bytes",
      inputLabel: "Input Source",
      outputLabel: "Converted Output",
      textPlaceholderEncode: "Enter UTF-8 text to encode (exact spaces & newlines preserved)…",
      textPlaceholderDecode: "Paste Base64, hexadecimal, or 8-bit binary string to decode…",
      selectFileBtn: "Choose File…",
      dropFileHint:
        "Or drop a local file (processed strictly as raw bytes without lossy text decoding)",
      runFileBtn: "Reconvert File",
      copyFullBtn: "Copy Full Result",
      copiedBadge: "Copied",
      saveOutputBtn: "Save As…",
      clearBtn: "Clear",
      statsSummary: (inBytes, outBytes) =>
        `Input ${inBytes.toLocaleString()} B → Output ${outBytes.toLocaleString()} B`,
      truncationBanner: (shownChars, totalChars, outBytes) =>
        `Output has ${totalChars.toLocaleString()} chars (${outBytes.toLocaleString()} B); preview shows first ${shownChars.toLocaleString()} chars. Copy Full Result and Save As export the complete data.`,
      binaryNonUtf8Banner: (outBytes) =>
        `Decoded ${outBytes.toLocaleString()} raw binary bytes containing non-UTF-8 sequences. WinKit does not corrupt binary bytes into replacement characters — inspect the 256-byte hex preview below or click Save As… to write exact bytes.`,
      hexPreviewHeading: "Raw Non-UTF-8 Byte Hex Preview (First 256 Bytes)",
      savedSuccess: (path, bytes) => `Saved ${bytes.toLocaleString()} exact bytes to: ${path}`,
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace this output file (original input file is never overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
      emptyOutput: "Type text or choose a local file to see converted output.",
    },
    uuidTool: {
      scopeNote:
        "Generates RFC 9562 UUID v4 and time-ordered v7 using OS CSPRNG (1–500 per batch). Does not claim cross-device collision impossibility or strict monotonicity across clock rollbacks; v4 carries no timestamp.",
      generatePaneTitle: "Generate UUIDs (v4 / v7)",
      inspectPaneTitle: "Inspect & Validate UUID",
      versionV4: "UUID v4 (Random)",
      versionV7: "UUID v7 (Unix Time-Ordered)",
      countLabel: "Count (1–500)",
      uppercaseLabel: "Uppercase",
      hyphensLabel: "Hyphens (-)",
      generateBtn: "Generate",
      copyAllBtn: "Copy All",
      copySingleBtn: "Copy",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      emptyGenerated: "Click Generate to create cryptographically random UUIDs.",
      inspectPlaceholder:
        "Paste a UUID (with or without hyphens, braces, or urn:uuid:) to inspect…",
      inspectValid: "Valid UUID",
      inspectInvalid: "Invalid UUID format",
      fieldCanonical: "Canonical Form",
      fieldVersion: "Version",
      fieldVariant: "Variant",
      fieldTimestamp: "Embedded Timestamp",
      fieldNotes: "Notes",
      v4NoTimestampNote: "UUID v4 consists of random bits and embeds no creation timestamp.",
      unsupportedTimeVersionNote: (ver) =>
        `UUID v${ver} detected; WinKit decodes embedded Unix millisecond timestamps for RFC 9562 v7 only and does not decode Gregorian clock fields for v${ver}.`,
      nilNote: "Special all-zero Nil UUID (RFC 9562 §5.9).",
      maxNote: "Special all-one Max UUID (RFC 9562 §5.10).",
    },
    timestampTool: {
      scopeNote:
        "Lossless BigInt conversion across seconds, milliseconds, microseconds, and nanoseconds (zero JS Number rounding). Offset-less dates require an explicit timezone and reject nonexistent/ambiguous DST transitions.",
      modeToDate: "Timestamp → Date/Time",
      modeToTs: "Date/Time → Timestamp",
      nowBtn: "Now",
      clearBtn: "Clear",
      copyBtn: "Copy",
      copiedBadge: "Copied",
      tsInputLabel: "Unix Timestamp Integer",
      tsPlaceholder: "Enter integer epoch (supports 0, negative values, and nanosecond BigInts)…",
      unitLabel: "Selected Unit",
      unitSec: "Seconds (s)",
      unitMs: "Milliseconds (ms)",
      unitUs: "Microseconds (µs)",
      unitNs: "Nanoseconds (ns)",
      usedUnitBadge: (unit) => `Interpreted as ${unit}`,
      suggestedUnitHint: (suggested, applyLabel) => ({
        text: `Magnitude looks like ${suggested} (your selected unit was kept unchanged)`,
        btn: applyLabel,
      }),
      subMsPrecisionNote: (subMsText) =>
        `Calendar display resolves to milliseconds; sub-millisecond remainder preserved: ${subMsText}`,
      dateInputLabel: "Date / Time String",
      datePlaceholder:
        "ISO 8601 with offset (e.g. 2026-11-18T09:30:00+08:00) or offset-less civil time (e.g. 2026-11-18 09:30:00.123456789)",
      interpretTzLabel: "Timezone for Offset-less Input",
      displayTzLabel: "Custom IANA Timezone",
      tzPlaceholder: "Valid IANA zone, e.g. America/New_York, Europe/London, Asia/Tokyo",
      cardUtc: "Coordinated Universal Time (UTC)",
      cardLocal: (tz) => `System Local Timezone (${tz})`,
      cardCustom: (tz) => `Selected IANA Timezone (${tz})`,
      isoLabel: "ISO 8601",
      offsetLabel: "UTC Offset",
      localCivilLabel: "Civil Date & Time",
      epochSecLabel: "Seconds (s)",
      epochMsLabel: "Milliseconds (ms)",
      epochUsLabel: "Microseconds (µs)",
      epochNsLabel: "Nanoseconds (ns)",
      precisionTruncatedNote:
        "Note: Coarser units truncate fractional sub-second components toward zero; full precision is preserved in µs/ns.",
      emptyPrompt: "Enter an integer timestamp or click Now to inspect multi-timezone conversions.",
    },
    wordCounterTool: {
      scopeNote:
        "Counts user-perceived characters via Unicode grapheme clusters and words/sentences via Intl.Segmenter (word counts can vary across editors). Input capped at 2 MiB; text is never logged or persisted.",
      inputLabel: "Input Text",
      placeholder: "Type or paste English, Chinese, or multilingual text…",
      clearBtn: "Clear",
      copySummaryBtn: "Copy Stats",
      copiedBadge: "Copied",
      statWords: "Words",
      statCharsWithSpaces: "Characters (with spaces)",
      statCharsNoWhitespace: "Characters (no whitespace)",
      statSentences: "Sentences",
      statParagraphs: "Paragraphs",
      statLines: "Lines",
      statUtf8Bytes: "UTF-8 Bytes",
      statReadingTime: "Est. Reading Time",
      statSpeakingTime: "Est. Speaking Time",
      estimateAssumptions:
        "Estimates assume ~350 CJK chars/min + ~220 Latin words/min silent reading, and ~180 CJK chars/min + ~140 Latin words/min speaking.",
      rulesNote:
        "Definitions: empty text = 0 lines & 0 paragraphs; CRLF/LF normalized for line splits (trailing newline adds a physical line); non-empty blocks separated by blank lines = paragraphs.",
      topWordsTitle: "Top Frequent Words (case-folded, common EN/ZH stopwords excluded, top 10)",
      topWordsEmpty: "Enter content words to see frequency counts.",
      limitExceeded: (maxMb) =>
        `Input exceeds the ${maxMb} MiB safety ceiling; shorten text to keep the UI responsive.`,
      formatDuration: (seconds) => {
        if (seconds <= 0) return "0 sec";
        if (seconds < 60) return `~${Math.max(1, Math.ceil(seconds))} sec`;
        const mins = Math.floor(seconds / 60);
        const rem = Math.round(seconds % 60);
        return rem > 0 ? `~${mins} min ${rem} sec` : `~${mins} min`;
      },
    },
    caseConverterTool: {
      scopeNote:
        "Converts across all 12 reference case & naming styles line by line while keeping your original input intact. Naming style conversion is lossy and does not translate or romanize text.",
      inputLabel: "Source Text / Identifier List (line by line)",
      outputLabel: "Converted Output",
      placeholder: "Enter titles, sentences, or identifiers (e.g. getHTTPResponse, version2Value)…",
      copyBtn: "Copy Output",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      stylesLabel: "Target Style (12 styles)",
      lineRuleNote:
        "Tokenizer splits acronym runs (HTTPResponse → http + response), camelCase, digit boundaries, and repeated delimiters; Title Case lowers standard English minor words and preserves mixed-case brands (e.g. iPhone, macOS, WinKit).",
      emptyPreview: "—",
      styleNames: {
        uppercase: "UPPERCASE",
        lowercase: "lowercase",
        title: "Title Case",
        sentence: "Sentence case",
        camel: "camelCase",
        pascal: "PascalCase",
        snake: "snake_case",
        constant: "CONSTANT_CASE",
        kebab: "kebab-case",
        dot: "dot.case",
        alternating: "aLtErNaTiNg",
        inverse: "iNVERSE",
      },
    },
    beautifierTool: {
      scopeNote:
        "Phase 1 subset: PNG/JPEG solid background framing, padding, rounded corners, drop shadow, and full-resolution Original / 1:1 / 16:9 PNG export (gradients, custom backdrops, and screen capture scheduled for Phase 3).",
      selectImageBtn: "Choose Image (PNG / JPEG)…",
      replaceImageBtn: "Change Image…",
      clearImageBtn: "Remove",
      dropImageHint: "Or drop a .png / .jpg / .jpeg image from File Explorer",
      previewLabel: "Live Layout Preview",
      sourceSizeLabel: "Source Pixels",
      outputSizeLabel: "Output Canvas",
      noUpscaleNote:
        "Exports render 1:1 from the full-resolution source image without upscaling or screenshotting the scaled preview.",
      bgColorLabel: "Solid Background",
      customColorLabel: "Custom Color",
      paddingLabel: "Padding",
      radiusLabel: "Corner Radius",
      shadowLabel: "Drop Shadow",
      aspectLabel: "Canvas Aspect Ratio",
      aspectOriginal: "Original",
      aspectSquare: "1 : 1 Square",
      aspectWide: "16 : 9 Wide",
      exportPngBtn: "Export PNG…",
      exportingBtn: "Rendering PNG…",
      exportedSuccess: (path, w, h) => `Exported PNG (${w} × ${h} px): ${path}`,
      emptyTitle: "Import a screenshot or image to frame",
      emptyDesc:
        "Select a local PNG or JPEG file or drop it here. Your original image is never modified.",
      limitHint:
        "Safety bounds: max 50 MB input, max 8192 px per source side, max 10000 px / 48 MP output canvas.",
      overwriteConfirmTitle: "Destination Image Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace this output file (original image will never be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
    },
    jwtTool: {
      scopeNote:
        "Offline 3-part JWS/JWT decoder (lossless 64-bit numbers, max 256 KiB) and 5-part JWE header inspector with local HS256 / HS384 / HS512 HMAC verification over raw segments (secret max 64 KiB; public-key algorithms are decoded-only and JWE reads header only).",
      tokenInputLabel: "JWT / JWS Token Input",
      tokenPlaceholder:
        "Paste a 3-part JWT (outer quotes and 'Bearer ' prefix are recognized automatically; never uploaded or saved to history)",
      sampleHs256Btn: "Load RFC Sample",
      clearBtn: "Clear Token & Secret",
      envelopeStrippedNote: (bearer, quotes) =>
        `Stripped outer wrapper (${[bearer ? "Bearer prefix" : "", quotes ? "matching quotes" : ""].filter(Boolean).join(", ")}) without altering internal token characters.`,
      statusSectionLabel: "Three Independent Inspection Dimensions",
      dimStructureLabel: "1. Structure & Decode",
      dimSignatureLabel: "2. Signature Verification",
      dimTimeLabel: "3. Time Claims",
      structEmpty: "Waiting for token input",
      structValidJws: (alg) => `Valid 3-part JWS decoded (alg: ${alg})`,
      structJweEncrypted: "5-part encrypted JWE (protected header only; no decryption)",
      structInvalid: "Invalid token structure or encoding",
      jweUnsupportedBody:
        "Detected a 5-segment encrypted JWE token (Protected Header · Encrypted Key · IV · Ciphertext · Tag). Only the readable protected header is shown offline; decryption is not supported.",
      sigUnverified: "Signature unverified (enter secret to verify)",
      sigVerifying: "Verifying HMAC…",
      sigValid: (alg, keyBytes) => `Signature valid (${alg}, ${keyBytes}-byte key)`,
      sigInvalid: "Signature invalid (HMAC mismatch)",
      sigAlgMismatch: (headerAlg, expectedAlg) =>
        `Algorithm mismatch (header ${headerAlg} ≠ expected ${expectedAlg})`,
      sigUnsignedNone: "Unsigned token (alg=none — no cryptographic signature)",
      sigUnsupportedAlg: (alg) =>
        `Decoded only; signature verification unsupported for alg: ${alg}`,
      sigUnsupportedCrit: (crit) => `Rejected: unsupported critical JOSE extension crit=${crit}`,
      sigInvalidBase64Key: "Invalid Base64 / Base64url secret key",
      nonAuthDisclaimer:
        "Note: A matching HMAC proves shared-secret possession over the raw segments only — it does not imply business authorization or issuer trust.",
      remoteKeyHintWarning:
        "Security note: Header includes jku / x5u key URL parameters; WinKit treats them strictly as inert text and never performs network fetches.",
      unsecuredNonEmptySigWarning:
        "Structure warning: Header declares alg=none, but segment 3 is non-empty (RFC 7515 requires an empty signature segment for unsecured JWS).",
      precisionNote:
        "Detected numeric claims exceeding IEEE 754 safe integers; formatted losslessly from raw JSON literals.",
      verifierSectionTitle: "Local HMAC Verification (Exact header.payload Bytes)",
      expectedAlgLabel: "Expected Algorithm",
      expectedAlgAuto: "Match Header Allowlist (HS256/384/512)",
      secretModeLabel: "Secret Encoding",
      secretModeUtf8: "Raw UTF-8 Text",
      secretModeBase64: "Base64 / Base64url Bytes",
      secretInputLabel: "Shared Secret (Masked)",
      secretPlaceholderUtf8: "Enter UTF-8 shared secret to verify HMAC locally",
      secretPlaceholderBase64: "Enter Base64 or Base64url encoded secret",
      showSecretBtn: "Show secret",
      hideSecretBtn: "Hide secret",
      timeActive: "Currently within valid time window",
      timeExpired: "Expired (now ≥ exp)",
      timeNotYetValid: "Not yet active (now < nbf)",
      timeNoWindow: "No exp / nbf time window provided",
      timeInvalidClaim: "Malformed or out-of-range time claim detected",
      evaluatedAtLabel: "Evaluated at",
      headerSectionTitle: "Header (JOSE JSON)",
      payloadSectionTitle: "Payload (Claims JSON)",
      rawSegmentsSectionTitle: "Raw Encoded Segments (Signing Input)",
      registeredClaimsTitle: "Registered Claims (RFC 7519)",
      copyHeaderJsonBtn: "Copy Header",
      copyPayloadJsonBtn: "Copy Payload",
      copyRawHeaderBtn: "Copy Raw Header",
      copyRawPayloadBtn: "Copy Raw Payload",
      copyRawSigBtn: "Copy Raw Signature",
      copiedBadge: "Copied",
      claimMissing: "Not provided",
      claimInvalidType: (raw) => `Invalid type (expected NumericDate seconds, got: ${raw})`,
      claimOutOfRange: (raw) => `Timestamp out of representable date range (raw: ${raw})`,
      claimZeroEpochBadge: "Unix Epoch Zero (0)",
      claimNames: {
        iss: "iss · Issuer",
        sub: "sub · Subject",
        aud: "aud · Audience",
        jti: "jti · JWT ID",
        exp: "exp · Expiration Time",
        nbf: "nbf · Not Before",
        iat: "iat · Issued At",
      },
    },
    diffTool: {
      scopeNote:
        "Side-by-side and inline line/word diff with exact Unified Diff export (up to 4 MiB / 50,000 lines per side; WinKit never applies patches to user files).",
      leftTitle: "Original (A)",
      rightTitle: "Modified (B)",
      leftPlaceholder: "Paste or type original text A, or open/drop a UTF-8 text file…",
      rightPlaceholder: "Paste or type modified text B, or open/drop a UTF-8 text file…",
      openLeftBtn: "Open Left…",
      openRightBtn: "Open Right…",
      swapBtn: "Swap A ↔ B",
      recompareBtn: "Recompare",
      clearBtn: "Clear",
      toggleInputsShow: "Show Input Editors",
      toggleInputsHide: "Collapse Input Editors",
      dropSideLabel: "Single-File Drop Target",
      dropSideLeft: "Left (A)",
      dropSideRight: "Right (B)",
      droppedTwoFilesInfo: (leftName, rightName, extraIgnored) =>
        `Loaded dropped files in order: Left (A) = ${leftName}, Right (B) = ${rightName}${extraIgnored ? " (extra files ignored)" : ""}.`,
      viewSideBySide: "Side-by-Side",
      viewInline: "Inline",
      ignoreWhitespaceLabel: "Ignore Whitespace & EOL",
      ignoreCaseLabel: "Ignore Case",
      prevHunkBtn: "Prev Diff",
      nextHunkBtn: "Next Diff",
      hunkIndicator: (current, total) => `Hunk ${current} / ${total}`,
      copyPatchBtn: "Copy Exact Unified Diff",
      copiedBadge: "Copied Patch",
      savePatchBtn: "Save .patch…",
      savedPatchSuccess: (path) => `Saved exact Unified Diff patch: ${path}`,
      overwriteConfirmTitle: "Patch File Already Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace it (neither Left nor Right source file can ever be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
      statusComputing: "Computing diff in background…",
      statusExactIdentical: (lines) => `Both sides are byte-for-byte identical (${lines} lines).`,
      statusFilteredIdenticalRawDiffers:
        "No visible differences under current ignore whitespace/case filters; raw A and B still differ in whitespace, case, or line endings (exact patch remains available).",
      statusDiffSummary: (hunks, added, deleted) =>
        `${hunks} diff hunk${hunks === 1 ? "" : "s"} · +${added} added · -${deleted} deleted`,
      filterPatchNotice:
        "Note: Display view is filtered by Ignore Whitespace/Case without mutating A or B; copied/saved Unified Diff is always generated from exact raw A/B so applying the patch reconstructs B.",
      fallbackLargeEditNotice:
        "Note: Edit distance exceeded the 6,000-step fine backtrack budget; middle block is shown as chunked replacement while the exact Unified Diff remains valid.",
      expandContextBtn: (count) => `Expand ${count} unchanged context lines`,
      showMoreRowsBtn: (shown, total) => `Load more rows (${shown} / ${total} rendered)`,
      noEofNewlineBadge: "No EOF newline",
      bomBadge: "UTF-8 BOM",
      emptyDiffHint:
        "Both sides are empty (0 lines). Paste text or open two UTF-8 files to inspect line and word differences.",
    },
    regexTool: {
      engineBadge: "Engine: ECMAScript / JavaScript RegExp (Worker-Isolated)",
      scopeNote:
        "Compile, match, and replace run inside a dedicated Web Worker with a strict 2,000 ms main-thread termination budget (partial matches before timeout are not kept). Caps: 16,384 UTF-16 code units pattern, 2 MiB text, 2,000 matches. Differences vs. ICU: no 'x' free-spacing flag; named replacement uses $<name>.",
      patternLabel: "Regular Expression (Pattern)",
      patternPlaceholder: "e.g. (?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})",
      flagsLabel: "Flags",
      flagsInputAria: "RegExp flags string",
      testTextLabel: "Test Text (Max 2 MiB, never modifies source file)",
      testTextPlaceholder:
        "Paste text or open a local UTF-8 file to test matching and replacement…",
      openTextFileBtn: "Open Text File…",
      stopWorkerBtn: "Stop Worker",
      clearBtn: "Clear",
      enableReplaceLabel: "Enable Replacement Preview",
      replacementLabel: "Replacement Template",
      replacementPlaceholder: "e.g. $<year>/$<month>/$<day> ($&, $1, $<name>, $$)",
      replacementSyntaxHint:
        "JS replacement tokens: $1..$99 numbered · $<name> named · $& full match · $` before · $' after · $$ literal $",
      offsetUnitNote:
        "Offset units: 0-based UTF-16 code-unit intervals [start, end); 1-based line and UTF-16 column.",
      statusEmptyPattern: "Enter a regular expression pattern to evaluate.",
      statusRunning: "Evaluating inside dedicated Worker (2000 ms budget)…",
      statusInvalidRegex: (msg) => `Invalid pattern or flag combination: ${msg}`,
      statusTimeout: (ms) =>
        `Execution exceeded ${ms} ms budget — dedicated Worker was terminated! UI remains responsive; simplify nested quantifiers and retry.`,
      statusCancelled: "Previous regex evaluation was cancelled.",
      statusWorkerError: (msg) => `Worker error: ${msg}`,
      statusNoMatch: (ms) => `0 matches (${ms} ms).`,
      statusMatched: (count, ms, truncated) =>
        `${count}${truncated ? "+" : ""} match${count === 1 ? "" : "es"} found (${ms} ms).`,
      matchesTruncatedWarn: (max) => `Match collection stopped at the ${max}-match safety cap.`,
      highlightTruncatedWarn: (max) =>
        `Highlight preview renders the first ${max} matches to keep scrolling smooth; all collected matches remain in the table.`,
      replacePreviewTruncatedWarn: (shown, full) =>
        `Preview shows the first ${shown.toLocaleString()} characters (${full.toLocaleString()} total UTF-16 units; 'Copy Full Replacement' copies the complete output).`,
      highlightPaneTitle: "Match Highlight Preview",
      matchesPaneTitle: "Matches & Capture Groups",
      replacementPaneTitle: "Replacement Preview (Source Untouched)",
      copyMatchesBtn: "Copy Matches",
      copyReplacementBtn: "Copy Full Replacement",
      copiedBadge: "Copied",
      colMatchNum: "#",
      colMatchText: "Match",
      colUtf16Range: "UTF-16 [s, e)",
      colLineCol: "Line : Col",
      colCaptures: "Numbered & Named Captures",
      zeroLengthBadge: "zero-length",
      unmatchedGroupBadge: "unmatched",
    },
    unicodeTool: {
      scopeNote: (version) =>
        `Offline Unicode ${version} UCD / UAX #29 / UTS #39 code-point inspector (up to 512 KiB / 50,000 code points). Default cleanup preserves LF/CR/Tab, combining marks, Emoji ZWJ, and script ZWNJ joiners; UTS #39 single-character prototypes are advisory and do not claim to detect all spoofing text.`,
      confusableNeutralNote:
        "Note: 'Potential Confusable' cites UTS #39 visual ASCII prototypes (e.g. Cyrillic а vs. Latin a) for awareness — it does not imply malicious intent and is normal in non-Latin text.",
      inputLabel: "Original Text (Click text or table row for bidirectional jump)",
      inputPlaceholder:
        "Paste or open UTF-8 text to inspect code-point names, UTF-8 bytes, zero-width/Bidi controls, and UTS #39 lookalikes…",
      openFileBtn: "Open File…",
      sampleBtn: "Load Diagnostic Sample",
      clearBtn: "Clear",
      attentionOnlyLabel: (count) => `Attention items only (${count})`,
      summaryStats: (cp, utf16, graphemes, bytes) =>
        `${cp} code points · ${utf16} UTF-16 units · ${graphemes} graphemes · ${bytes} UTF-8 bytes`,
      tablePaneTitle: "Code-Point Breakdown (Click any row to highlight in source text)",
      pageInfo: (start, end, total) => `Showing ${start}–${end} of ${total}`,
      prevPageBtn: "Prev",
      nextPageBtn: "Next",
      colCpIdx: "CP#",
      colUtf16: "UTF-16",
      colGrapheme: "Graph#",
      colHex: "U+XXXX",
      colGlyph: "Glyph",
      colName: "Official Unicode Name / State",
      colCategoryScript: "Category · Script",
      colUtf8: "UTF-8 Bytes",
      colFlags: "Attention Flags",
      flagLabels: {
        bom: "BOM / ZWNBSP",
        zero_width: "Zero-Width Format",
        joiner_or_variation_selector: "Joiner / Variation Selector",
        bidi_control: "Bidi Control",
        special_whitespace: "Special Whitespace",
        control_char: "Control Char",
        combining_mark: "Combining Mark",
        potential_confusable: "Potential Confusable (UTS #39)",
        private_or_unassigned: "Private Use / Unassigned",
      },
      confusableProtoPrefix: "Prototype",
      sanitizerPaneTitle: "Previewable Sanitizer (Original Input Preserved)",
      optRemoveBom: "Remove leading & embedded BOM (U+FEFF)",
      optRemoveZeroWidth: "Remove non-joiner zero-width format chars (ZWSP / WJ / SHY)",
      optNormalizeSpaces:
        "Convert special non-ASCII spaces (NBSP / Ideographic) to ASCII space (keeps LF/CR/Tab)",
      optRemoveControls: "Remove non-standard C0/C1 control chars (keeps LF/CR/Tab)",
      optRemoveBidi:
        "Remove Bidi override & isolate controls (RLO / LRI, prevents visual reordering)",
      optRemoveJoiners:
        "Remove joiners & variation selectors (ZWJ / ZWNJ / VS — warning: splits ZWJ emojis & Persian ZWNJ)",
      optReplaceConfusables:
        "Replace UTS #39 confusables with ASCII prototypes (off by default; avoid on full non-Latin prose)",
      changesSummary: (count, truncated) =>
        `Previewed edits: ${count}${truncated ? "+" : ""} removal/replacement item${count === 1 ? "" : "s"}`,
      noChangesNote: "No characters would be modified under the current sanitizer options.",
      previewLabel: "Cleaned Output Preview",
      copyCleanedBtn: "Copy Cleaned Text",
      saveCleanedBtn: "Save Cleaned As…",
      copiedBadge: "Copied",
      savedSuccess: (path) => `Saved cleaned text: ${path}`,
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace it (your original input file will never be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
      emptyHint:
        "Enter or open text above to inspect Unicode names, UTF-8 byte sequences, and previewable sanitization.",
    },
    cleanLinksTool: {
      scopeNote: (ruleVersion) =>
        `Local rule catalog (${ruleVersion}): strips known universal & site-specific tracking parameters and unwraps Google / Facebook / Instagram / Outlook Safe Links / LinkedIn redirects offline (max 5 layers, zero network fetches) while preserving raw query encoding and presigned URLs. Cap: 1 MiB / 5,000 lines.`,
      inputLabel: "Input URLs (One HTTP / HTTPS URL per line)",
      inputPlaceholder:
        "Paste one or more URLs (one per line; invalid lines are explained in place without clearing valid URLs)…",
      readClipboardBtn: "Read Clipboard & Preview",
      replaceClipboardBtn: "Clean & Replace Clipboard (All-Links Only)",
      sampleBtn: "Load Synthetic Sample",
      clearBtn: "Clear",
      copyAllBtn: (count) => `Copy All Valid (${count})`,
      copySingleBtn: "Copy",
      copiedBadge: "Copied",
      rulesSummaryTitle: "Rule Coverage & Preservation Boundaries",
      rulesSummaryBody:
        "Universal: utm_*, hsa_*, mtm_*, fbclid, gclid, msclkid, mc_cid/mc_eid, _hsenc/_hsmi, mkt_tok, _ga/_gl, etc. Site-specific: YouTube/Spotify (si, etc.), Instagram (igsh/igshid), TikTok (_t/_r/share_*), Amazon (pd_rd_*/pf_rd_*/qid/sr/ref_), X status URLs (s/t), LinkedIn, Reddit. Generic names (id, token, ref, source, q, page) are preserved; presigned URLs (sig, X-Amz-Signature, etc.) are kept intact. No background clipboard monitoring.",
      clipboardReadEmpty: "Clipboard is empty or contains no plain text.",
      clipboardLoadedPreview:
        "Loaded clipboard text into editor; review the cleaned preview before copying.",
      clipboardReplacedOk: (changed, total) =>
        `Cleaned and updated clipboard (${total} valid link${total === 1 ? "" : "s"}, ${changed} modified).`,
      clipboardKeptNonLinks:
        "Clipboard contains non-HTTP(S) text — system clipboard was left untouched (loaded below for inspection).",
      clipboardLimitExceeded:
        "Clipboard text exceeds the 1 MiB / 5,000-line limit; clipboard left untouched.",
      statusEmpty:
        "Paste URLs or read clipboard to inspect removed trackers and unwrapped redirects.",
      statusLimitBytes: (actual, limit) =>
        `Input size (${actual.toLocaleString()} bytes) exceeds the ${limit.toLocaleString()}-byte (1 MiB) limit.`,
      statusLimitLines: (actual, limit) =>
        `Line count (${actual.toLocaleString()}) exceeds the ${limit.toLocaleString()}-line limit.`,
      statusSummary: (valid, changed, removedParams, unwrapped, invalid) =>
        `${valid} valid URL${valid === 1 ? "" : "s"} (${changed} cleaned · ${removedParams} param${removedParams === 1 ? "" : "s"} removed · ${unwrapped} unwrapped)${invalid > 0 ? ` · ${invalid} invalid line${invalid === 1 ? "" : "s"}` : ""}`,
      resultsPaneTitle: "Per-Line Cleaning & Unwrap Breakdown",
      cleanedOutputPaneTitle: "Cleaned Valid URLs",
      linePrefix: (n) => `Line ${n}`,
      badgeCleaned: "Cleaned",
      badgeUnchanged: "Unchanged",
      badgePresignedSkipped: (key) => `Presigned URL (${key}) · Skipped`,
      badgeInvalid: "Invalid",
      removedParamsLabel: "Removed params:",
      scopeUniversal: "Universal",
      scopeSite: "Site",
      unwrappedChainLabel: "Unwrapped via:",
      unwrapStoppedNote: {
        missing_target_param: (provider) =>
          `Matched ${provider} path, but target query parameter was missing; kept wrapper URL.`,
        ambiguous_target_param: (provider) =>
          `${provider} contained conflicting target parameters; kept original URL.`,
        malformed_target_encoding: (provider) =>
          `${provider} target parameter had malformed percent-encoding; kept original URL.`,
        non_http_or_invalid_target: (provider) =>
          `${provider} single-pass decoded target was not a valid HTTP/HTTPS URL; stopped unwrapping.`,
        target_too_long: (provider) =>
          `${provider} target exceeded length limit; stopped unwrapping.`,
        cycle_detected: (provider) => `Redirect cycle detected in ${provider}; stopped unwrapping.`,
        max_depth_reached: (depth) => `Stopped after maximum unwrap depth (${depth} layers).`,
      },
      invalidReasons: {
        not_http_url:
          "Only explicit http:// or https:// URLs are accepted (plain text and other schemes are not converted).",
        contains_whitespace_or_control: "URL contains internal spaces or control characters.",
        url_too_long: "Single URL exceeds the 16,384 UTF-16 code-unit limit.",
        malformed_url: "Malformed URL syntax or missing hostname.",
      },
      malformedKeyPreservedNote: (count) =>
        `Note: ${count} parameter name(s) had non-standard percent sequences and were conservatively preserved verbatim.`,
    },
    loremTool: {
      scopeNote:
        "Generates placeholder text offline from a fixed classical Latin vocabulary (no external APIs or models). The classic opening counts toward the requested word/sentence/paragraph total; HTML <p> tags do not count as words.",
      unitLabel: "Unit",
      unitWords: "Words",
      unitSentences: "Sentences",
      unitParagraphs: "Paragraphs",
      countLabel: (min, max) => `Count (${min}–${max})`,
      formatLabel: "Format",
      formatPlain: "Plain Text",
      formatHtml: "HTML (<p>)",
      formatMarkdown: "Markdown",
      classicStartLabel: "Start with classic 'Lorem ipsum dolor sit amet…'",
      regenerateBtn: "New",
      copyBtn: "Copy",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      outputPaneTitle: "Generated Placeholder Text (Rendered as Inert Text)",
      statusStats: (words, sentences, paragraphs, chars) =>
        `Generated: ${words.toLocaleString()} word${words === 1 ? "" : "s"} · ${sentences.toLocaleString()} sentence${sentences === 1 ? "" : "s"} · ${paragraphs.toLocaleString()} paragraph${paragraphs === 1 ? "" : "s"} · ${chars.toLocaleString()} chars`,
      statusCleared:
        "Output cleared. Change any setting or click New to generate placeholder text.",
      errNonInteger:
        "Enter a positive integer count (0, negative values, and decimals are rejected).",
      errOutOfRange: (min, max) =>
        `Count for this unit must be between ${min} and ${max.toLocaleString()}.`,
      errBudgetExceeded: (maxChars) =>
        `Estimated output exceeds the ${maxChars.toLocaleString()}-character safety budget; reduce the count.`,
    },
    passwordTool: {
      scopeNote:
        "Local password & English passphrase generator (not a crypto-wallet BIP39 seed tool). Uses OS CSPRNG with unbiased rejection sampling, masks results by default, and writes to clipboard only when you click Copy.",
      modePassword: "Password",
      modePassphrase: "Passphrase",
      batchCountLabel: "Batch Size (1–50)",
      passwordLengthLabel: "Length (8–128)",
      wordCountLabel: "Words (3–12)",
      charClassesTitle: "Character Categories & Rules",
      optUppercase: "Uppercase (A–Z)",
      optLowercase: "Lowercase (a–z)",
      optDigits: "Digits (0–9)",
      optSymbols: "Symbols (!@#$%^&*()-_=+[]{};:,.<>?/|~)",
      optExcludeLookAlikes: "No look-alikes (0, O, o, 1, l, I, |)",
      optRequireEachClass: "Require ≥ 1 char from each selected class (bounded rejection)",
      passphraseOptionsTitle: "Passphrase Format (EFF 7,772-word list, uniform with replacement)",
      separatorLabel: "Separator",
      sepHyphen: "Hyphen (-)",
      sepSpace: "Space ( )",
      sepDot: "Period (.)",
      sepUnderscore: "Underscore (_)",
      sepNone: "None (empty)",
      optCapitalize: "Capitalize words",
      optIncludeNumber: "Append 2-digit random number (00–99)",
      generateBtn: "Generate",
      regenerateBtn: "Regenerate",
      revealBtn: "Reveal",
      hideBtn: "Mask",
      copyBatchBtn: (count) => `Copy Batch (${count})`,
      copySingleBtn: "Copy",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      strengthTitle: "Model-Estimated Entropy & Strength",
      tierLabels: {
        weak: "Weak (< 50 bits)",
        fair: "Fair (50–69 bits)",
        strong: "Strong (70–99 bits)",
        very_strong: "Very Strong (≥ 100 bits)",
      },
      bitsExactLabel: (bits) => `~${bits.toFixed(2)} bits (generator model estimate)`,
      bitsUpperBoundLabel: (bits) => `Selection Upper Bound: ≤ ${bits.toFixed(2)} bits`,
      modelAssumptions: {
        independent_uniform_chars: (poolSize) =>
          `Model assumption: independent uniform draws over ${poolSize} deduplicated characters (L × log2(${poolSize})). Arbitrary crack-time guesses are omitted.`,
        constrained_all_selected_classes: (poolSize, upperBits) =>
          `Model assumption: uniform bounded rejection sampling over ${poolSize} characters requiring every selected class; exact inclusion-exclusion count applied (unconstrained upper bound: ${upperBits.toFixed(2)} bits).`,
        independent_words_with_replacement: (dictSize, isUpperBound) =>
          isUpperBound
            ? `Model assumption: independent uniform draws with replacement over ${dictSize.toLocaleString()} lowercase words; with an empty separator and lowercase words, distinct compound sequences can collide, so this figure is marked strictly as a selection upper bound.`
            : `Model assumption: independent uniform draws with replacement over ${dictSize.toLocaleString()} pure-alpha words (EFF Long Wordlist hyphen-free subset, CC BY 4.0); fixed separators and deterministic capitalization add 0 bits, and the optional 00–99 suffix adds log2(100) ≈ 6.64 bits.`,
      },
      memoryPrivacyNote:
        "Memory note: Results live only in current session memory, re-mask on tool switch, and drop references on Clear/Regenerate without writing to disk (managed JS/OS memory cannot guarantee cryptographic RAM zeroization).",
      staleBanner:
        "Settings changed since the batch below was generated (copying stale results is disabled); click Regenerate to produce items matching the current settings.",
      emptyPrompt:
        "Configure options above and click Generate to draw passwords or passphrases from the OS CSPRNG.",
      resultsPaneTitle: (count, masked) =>
        `Generated Batch (${count} item${count === 1 ? "" : "s"} · ${masked ? "Masked" : "Revealed"})`,
      errInvalidLength: (min, max) => `Password length must be an integer from ${min} to ${max}.`,
      errInvalidWordCount: (min, max) => `Word count must be an integer from ${min} to ${max}.`,
      errInvalidBatchCount: (min, max) => `Batch count must be an integer from ${min} to ${max}.`,
      errNoCharset: "Enable at least one character category (A–Z, a–z, 0–9, or symbols).",
      errImpossibleConstraints:
        "Password length is shorter than the number of required character categories.",
    },
    csvJsonTool: {
      scopeNote:
        "CSV ↔ JSON conversion and CSV / JSON → Markdown table export (no reverse Markdown parser). Runs inside a dedicated Worker with lossless >2^53 integers, exact decimals, and leading-zero preservation; caps: 8 MiB input / 16 MiB output.",
      directionLabel: "Direction",
      dirCsvToJson: "CSV → JSON",
      dirJsonToCsv: "JSON → CSV",
      dirCsvToMd: "CSV → Markdown",
      dirJsonToMd: "JSON → Markdown",
      delimiterLabel: "Delimiter",
      delimAuto: "Auto",
      delimComma: "Comma (,)",
      delimSemicolon: "Semicolon (;)",
      delimTab: "Tab",
      firstRowHeaders: "First row headers",
      detectTypes: "Detect types",
      emptyCellsAsNull: "Empty cell → null",
      formulaProtection: "Formula protection",
      advancedSummaryTitle: "Advanced Structure, Flattening & Export Options",
      headerPolicyLabel: "Empty/Duplicate Headers",
      headerPolicyError: "Error (prevent overwrite)",
      headerPolicyRename: "Auto-rename with preview",
      raggedPolicyLabel: "Ragged Row Lengths",
      raggedPolicyError: "Error with exact row/line",
      raggedPolicyPad: "Pad short & keep extra cols",
      arrayModeLabel: "Plain Scalar Arrays",
      arrayModeSemicolon: "Join with ';'",
      arrayModeJson: "Compact JSON",
      pathPolicyLabel: "Dot-Key Path Collisions",
      pathPolicyError: "Error (prevent overwrite)",
      pathPolicyBracket: "Bracket-escape keys",
      csvEolLabel: "CSV Line Ending",
      csvBomLabel: "Prepend UTF-8 BOM",
      mappingRulesNote:
        "Rules: CSV cells stay strings by default; Detect Types converts only unpadded canonical JSON numbers, true/false, and null (leading-zero codes like 00123 stay strings). JSON → CSV maps null/missing keys to empty cells; Markdown maps cell line breaks to <br> and escapes \\ and |. CSV cannot preserve all JSON types round-trip.",
      openFileBtn: "Open File…",
      sampleBtn: "Load Sample",
      cancelWorkerBtn: "Cancel",
      copyBtn: "Copy Full Output",
      copiedBadge: "Copied",
      saveBtn: "Save As…",
      clearBtn: "Clear",
      viewTextTab: "Output Text",
      viewTableTab: "Table Preview",
      inputPaneTitle: (fileName) =>
        fileName ? `Source (${fileName})` : "Input (Drop .csv / .tsv / .json)",
      outputPaneTitle: "Converted Output (Copy & Save Export Full Data)",
      csvPlaceholder:
        "Paste CSV / TSV text, or open / drop a UTF-8 file (supports quoted delimiters, escaped quotes, and multi-line cells)…",
      jsonPlaceholder:
        "Paste a JSON array of objects [{...}], row arrays [[...]], or single object, or open / drop a .json file…",
      statusEmpty: "Paste or open CSV / TSV / JSON data to convert in background.",
      statusRunning: "Parsing and converting in dedicated Worker…",
      statusCancelled: "Cancelled previous conversion.",
      statusOk: (rows, cols) =>
        `Converted: ${rows.toLocaleString()} row${rows === 1 ? "" : "s"} × ${cols.toLocaleString()} column${cols === 1 ? "" : "s"}`,
      detectedDelimiterBadge: (delimName, ambiguous) =>
        ambiguous
          ? `Ambiguous delimiter (using ${delimName}; manual selection recommended)`
          : `Detected: ${delimName}`,
      statusErrorLoc: (msg, physicalLine, col, recordNum) => {
        const parts: string[] = [];
        if (recordNum !== undefined) parts.push(`record #${recordNum}`);
        if (physicalLine !== undefined) parts.push(`physical line ${physicalLine}`);
        if (col !== undefined) parts.push(`col ${col}`);
        return parts.length > 0 ? `Error (${parts.join(", ")}): ${msg}` : `Error: ${msg}`;
      },
      previewTruncatedNote: (shownChars, fullChars) =>
        `Preview shows first ${shownChars.toLocaleString()} of ${fullChars.toLocaleString()} chars (Copy Full Output and Save As write the complete result).`,
      tableTruncatedNote: (shownRows, totalRows, shownCols, totalCols) =>
        `Table preview renders first ${shownRows}/${totalRows} rows and ${shownCols}/${totalCols} columns.`,
      formulaDetectedWarn: (count) =>
        `Detected ${count} cell(s) starting with = / + / @ / non-numeric - / control chars (Formula Protection is off — raw data is unchanged; CSV double quotes alone do not block spreadsheet formula execution).`,
      formulaProtectedInfo: (count) =>
        `Prefixed ${count} formula-like cell(s) with ' (genuine negative numbers like -42.5 were kept unchanged; note ' alters the leading character and behavior varies across spreadsheet apps).`,
      formulaPreviewHeading: "Formula protection preview (up to 5):",
      renamedHeadersNotice: (items) => `Auto-renamed empty/duplicate headers: ${items}`,
      raggedAdjustedNotice: (padded, extended) =>
        `Adjusted ragged rows: ${padded} short row(s) padded, ${extended} extra column(s) preserved.`,
      ambiguousArrayNotice: (count) =>
        `Note: ${count} scalar array(s) were empty or contained ';', null, or empty strings; switch Plain Scalar Arrays to 'Compact JSON' if lossless round-trip is needed.`,
      depthCappedNotice: (count, maxDepth) =>
        `${count} nested object(s) reached max depth (${maxDepth}) and were kept as compact JSON cells.`,
      singleObjectNotice: "JSON root was a single object and was converted as a 1-row record.",
      savedSuccess: (path, bytes) =>
        `Saved complete output (${bytes.toLocaleString()} bytes): ${path}`,
      saveAbortedInputChanged:
        "Input or conversion options changed while the Save dialog was open; save cancelled to prevent mixing stale content.",
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace it (your source input file can never be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
    },
    coordinateTool: {
      offlineBadge: "WGS 84 · Offline",
      scopeNote:
        "Offline 2D WGS 84 coordinate conversion across 8 formats, ellipsoid geodesic distance, and bounded batch export (no online tiles, geocoding, or device location).",
      tabSingle: "Convert",
      tabDistance: "Distance",
      tabBatch: "Batch",
      modePaste: "Single Expression / Link",
      modeSeparate: "Separate Lat / Lon",
      plainOrderLabel: "Unlabeled Text Order",
      orderLatLon: "Lat, Lon",
      orderLonLat: "Lon, Lat",
      singleInputLabel: "Coordinate Expression or Maps Link (16 KiB max)",
      singlePlaceholder:
        "Paste DD (37.8197, -122.4786), DMS (37°49′10.92″N 122°28′42.96″W), GeoJSON Point, WKT POINT, geo:, or Apple / Google Maps coordinate URL…",
      latFieldLabel: "Latitude [-90°, 90°]",
      lonFieldLabel: "Longitude [-180°, 180°]",
      latPlaceholder: "e.g. 37.8197 or 37°49′10.92″N",
      lonPlaceholder: "e.g. -122.4786 or 122°28′42.96″W",
      ddDecLabel: "DD decimals (0–8)",
      dmDecLabel: "DM decimals (0–4)",
      dmsDecLabel: "DMS sec decimals (0–4)",
      precisionHint:
        "Display digits control formatting rounding (with carry propagation) only, not physical positioning accuracy, and never truncate internal coordinates or distance inputs.",
      sampleBtn: "Load Sample",
      clearBtn: "Clear",
      sendToABtn: "Use as Point A",
      sendToBBtn: "Use as Point B",
      detectedBadge: (fmt, order) => `Detected: ${fmt} · Axis order: ${order}`,
      detectedFormatNames: {
        separate_fields: "Separate Lat/Lon Fields",
        dd: "DD (Decimal Degrees)",
        dm: "DM (Degrees & Decimal Minutes)",
        dms: "DMS (Degrees Minutes Seconds)",
        geojson_point: "GeoJSON Point",
        wkt_point: "WKT POINT",
        geo_uri: "geo: URI",
        apple_maps_url: "Apple Maps Coordinate URL",
        google_maps_url: "Google Maps Coordinate URL",
      },
      axisOrderNames: {
        lat_lon: "Latitude first (Lat, Lon)",
        lon_lat: "Longitude first (Lon, Lat)",
        hemisphere_tagged: "Determined by N/S/E/W hemispheres",
      },
      outputsPaneTitle: "Eight Standard WGS 84 Representations (Copy Only — Never Opens Browser)",
      emptySinglePrompt: "Enter or paste a valid 2D WGS 84 coordinate to generate all 8 formats.",
      formatLabels: {
        dd: "DD (Decimal Degrees)",
        dms: "DMS (Deg Min Sec)",
        dm: "DM (Decimal Minutes)",
        geojson: "GeoJSON Point",
        wkt: "WKT Point",
        geo_uri: "geo: URI",
        apple_maps: "Apple Maps Link",
        google_maps: "Google Maps Link",
      },
      formatMeta: {
        dd: "latitude, longitude",
        dms: "deg°min′sec″N/S E/W",
        dm: "deg°min′N/S E/W",
        geojson: "RFC 7946 [longitude, latitude]",
        wkt: "POINT (longitude latitude) · WGS 84 convention",
        geo_uri: "RFC 5870 geo:latitude,longitude",
        apple_maps: "coordinate=latitude,longitude",
        google_maps: "api=1&query=latitude%2Clongitude",
      },
      copyBtn: "Copy",
      copiedBadge: "Copied",
      pointATitle: "Point A",
      pointBTitle: "Point B",
      pointPlaceholder: "Enter DD / DMS / DM / GeoJSON / WKT / geo: / coordinate URL…",
      fillFromCurrentBtn: "Fill from Convert Tab",
      swapPointsBtn: "Swap A ↔ B",
      sampleAntipodalBtn: "Near-Antipodal Sample",
      sampleDatelineBtn: "Antimeridian Sample",
      pointAErrorPrefix: (msg) => `Point A error: ${msg}`,
      pointBErrorPrefix: (msg) => `Point B error: ${msg}`,
      distanceResultTitle: "WGS 84 Ellipsoid Inverse Geodesic Distance",
      distanceEmptyPrompt:
        "Enter valid coordinates for Point A and Point B to compute shortest ellipsoid surface distance.",
      unitKilometers: "Kilometers (km)",
      unitMeters: "Meters (m)",
      unitMiles: "Miles (mi)",
      distanceModelNote:
        "Model: Shortest surface geodesic on the WGS 84 reference ellipsoid (a = 6378137 m, f = 1/298.257223563, GeographicLib Karney algorithm) — not driving/walking route or 3D elevation distance.",
      batchInputTitle: (fileName) =>
        fileName
          ? `Batch Source (${fileName})`
          : "One Coordinate Expression per Line (1 MiB / 5,000 lines)",
      batchPlaceholder:
        "Paste one DD, DMS, DM, single-line GeoJSON Point, WKT POINT, geo:, or coordinate URL per line (use Single-Point view for multi-line GeoJSON; address geocoding is not supported)…",
      batchOutputFormatLabel: "Target Format",
      batchCsvScopeLabel: "CSV Rows",
      batchCsvScopeAll: "All rows (include errors, recommended)",
      batchCsvScopeValid: "Valid rows only",
      batchFormulaProtection: "Formula protection",
      openBatchFileBtn: "Import File…",
      cancelBatchBtn: "Cancel",
      copyValidBtn: (count) => `Copy Valid (${count})`,
      exportCsvBtn: "Save CSV…",
      batchStatusEmpty: "Paste or import one coordinate expression per line to convert in Worker.",
      batchStatusRunning: "Parsing and formatting batch in dedicated Worker…",
      batchStatusCancelled: "Cancelled previous batch conversion.",
      batchStatusSummary: (valid, errors, skippedBlank) =>
        `Done: ${valid.toLocaleString()} valid · ${errors.toLocaleString()} error(s)` +
        (skippedBlank > 0
          ? ` · ${skippedBlank.toLocaleString()} blank line(s) skipped (source line numbers preserved)`
          : ""),
      batchPreviewTruncated: (shown, total) =>
        `Preview shows first ${shown.toLocaleString()} of ${total.toLocaleString()} non-blank rows; Copy and Save CSV export the full output (8 MiB UTF-8 cap).`,
      batchScopeRuleNote:
        "Note: Offline 2D WGS 84 coordinate parsing only (no address geocoding or reverse lookup); blank lines are skipped without shifting source line numbers.",
      colLine: "Line #",
      colRaw: "Original Input",
      colStatus: "Status",
      colLat: "Latitude",
      colLon: "Longitude",
      colResultOrError: "Formatted Output / Error",
      badgeOk: "OK",
      badgeErr: "Error",
      savedCsvSuccess: (path, bytes) =>
        `Saved batch coordinate CSV (${bytes.toLocaleString()} bytes): ${path}`,
      saveAbortedChanged:
        "Batch input or export options changed while the Save dialog was open; save cancelled to prevent writing stale data.",
      overwriteConfirmTitle: "Destination File Exists",
      overwriteConfirmBody: (path) =>
        `"${path}" already exists. Replace it (your imported source file can never be overwritten)?`,
      overwriteConfirmAccept: "Replace File",
      cancel: "Cancel",
    },
  },
};
