export type Locale = "zh-CN" | "en-US";
export type ThemePreference = "light" | "dark" | "system";

export interface Messages {
  appName: string;
  nav: {
    home: string;
    favorites: string;
    recent: string;
    settings: string;
    availableToolsHeading: string;
  };
  categories: {
    all: string;
    developer: string;
    image: string;
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
    drainingTitle: string;
    errorTitle: string;
    body: (count: number, writeCount: number) => string;
    bodyFinished: string;
    drainingBody: string;
    timeoutBody: (remaining: string) => string;
    stayButton: string;
    quitAnywayButton: string;
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
    DISK_FULL: string;
    SIZE_LIMIT_EXCEEDED: string;
    DECODE_FAILED: string;
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
    algorithmBadge: string;
    scopeNote: string;
    textInputLabel: string;
    textPlaceholder: string;
    exactBytesNote: string;
    byteCount: (bytes: number) => string;
    selectFileBtn: string;
    dropFileHint: string;
    selectedFileLabel: string;
    fileSizeLabel: string;
    computeBtn: string;
    cancelBtn: string;
    uppercaseLabel: string;
    digestLabel: string;
    copyBtn: string;
    copiedBadge: string;
    clearBtn: string;
    compareLabel: string;
    comparePlaceholder: string;
    compareIdle: string;
    compareInvalidFormat: string;
    compareMatch: string;
    compareMismatch: string;
    statusIdle: string;
    statusRunning: (pct: string) => string;
    statusCompleted: string;
    statusCancelled: string;
    statusError: string;
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
}

export const MESSAGES: Record<Locale, Messages> = {
  "zh-CN": {
    appName: "WinKit",
    nav: {
      home: "全部工具",
      favorites: "收藏夹",
      recent: "最近使用",
      settings: "设置",
      availableToolsHeading: "当前可用工具",
    },
    categories: {
      all: "全部分类",
      developer: "开发者",
      image: "图片",
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
      titleFavorites: "收藏夹",
      titleRecent: "最近使用",
      subtitleAvailable: (count) => `当前已上线 ${count} 项本地工具，所有处理均在本机离线完成`,
      scopeFull: "完整支持",
      scopePartial: "部分实现",
      openTool: "打开",
      favoriteAdd: "加入收藏",
      favoriteRemove: "取消收藏",
      emptySearch: "没有匹配当前搜索词的已上线工具。",
      emptyFavorites: "尚未收藏任何工具。点击工具条目右侧星标即可添加。",
      emptyRecent: "暂无最近使用记录。",
      emptyRegistry: "当前构建尚未注册工具。",
      clearSearch: "清空筛选",
      baselineFooter:
        "仅展示当前阶段已完成闭环并验证通过的工具；其余规划条目记录于 docs/PARITY_MATRIX.md。",
    },
    settings: {
      title: "设置",
      subtitle: "外观、语言与本地隐私边界控制",
      appearanceSection: "外观主题",
      themeLabel: "主题模式",
      themeLight: "浅色（推荐）",
      themeDark: "深色",
      themeSystem: "跟随系统",
      languageSection: "界面语言",
      languageLabel: "显示语言",
      langZh: "简体中文",
      langEn: "English",
      privacySection: "会话状态与本地隐私",
      privacySessionNote:
        "在工具间切换时，当前输入与参数仅保留在应用进程内存中；退出应用后立即释放，默认绝不将输入正文、文件内容、密钥或令牌写入磁盘。",
      privacyLocalNote:
        "磁盘仅保存主题、语言、收藏列表与最近访问的工具编号，无任何遥测、账号或联网分析。",
      clearRecentButton: "清空最近使用记录",
      clearRecentDone: "已清空最近使用记录",
      resetPrefsButton: "恢复默认设置",
      resetPrefsDone: "已恢复默认外观与语言设置",
      runtimeSection: "运行环境信息",
    },
    closeGuard: {
      title: "仍有本地任务正在运行",
      drainingTitle: "正在安全收尾并退出…",
      errorTitle: "暂时无法完成退出",
      body: (count, writeCount) =>
        writeCount > 0
          ? `当前有 ${count} 个任务尚未结束（含 ${writeCount} 个文件写入收尾步骤）。当前版本不支持在系统托盘后台继续运行；确认退出后将取消可中断任务，并等待短时文件写入安全落盘后关闭。`
          : `当前有 ${count} 个本地任务正在运行。当前版本不支持关闭窗口后在系统托盘继续运行，现在退出将取消未完成的任务并在释放文件句柄后关闭。`,
      bodyFinished: "刚才运行的后台任务已经结束，现在可以直接退出 WinKit，或留在当前工作区。",
      drainingBody:
        "正在请求任务停止、等待文件写入安全收尾并释放文件句柄，请稍候（收尾期间已锁定退出流程）…",
      timeoutBody: (remaining) =>
        `等待后台任务结束超时（仍未结束：${remaining}）。为保护文件完整性未强制终止进程；你可以重试退出或先返回应用查看状态（已发出取消请求的任务不会自动恢复）。`,
      stayButton: "继续使用",
      quitAnywayButton: "取消任务并退出",
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
      DISK_FULL: "目标磁盘剩余空间不足，无法完成写入。",
      SIZE_LIMIT_EXCEEDED: "文件体积或画布像素超出安全上限。",
      DECODE_FAILED: "文件编码或图像格式无法解析，请检查文件是否完整。",
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
      indentLabel: "缩进方式",
      indent2: "2 空格",
      indent4: "4 空格",
      indentTab: "Tab 制表符",
      sortKeysLabel: "按键名字母序排列",
      statusEmpty: "等待输入 JSON 内容",
      statusValid: (kind) => `合法 JSON（根类型：${kind}）`,
      statusInvalid: "JSON 语法错误",
      locateErrorBtn: "定位到错误位置",
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
      modeFile: "本地文件",
      algorithmBadge: "SHA-256",
      scopeNote:
        "阶段 1 子集：提供 UTF-8 文本与任意大小本地文件流式 SHA-256 校验（其余算法见阶段 2 规划）。",
      textInputLabel: "待计算文本",
      textPlaceholder: "输入或粘贴任意文本…",
      exactBytesNote:
        "按原始 UTF-8 字节精确计算，完整保留首尾空格、制表符与换行符，不做任何自动修剪。",
      byteCount: (bytes) => `${bytes.toLocaleString()} UTF-8 字节`,
      selectFileBtn: "选择本地文件…",
      dropFileHint: "也可直接将文件从资源管理器拖入此工作区（只读流式计算，绝不改动原文件）",
      selectedFileLabel: "当前文件",
      fileSizeLabel: "文件大小",
      computeBtn: "重新计算",
      cancelBtn: "取消计算",
      uppercaseLabel: "大写十六进制",
      digestLabel: "SHA-256 摘要结果",
      copyBtn: "复制摘要",
      copiedBadge: "已复制",
      clearBtn: "清空",
      compareLabel: "期望摘要比对（可选）",
      comparePlaceholder:
        "粘贴发布的 SHA-256（支持 sha256: 前缀、shasum 输出、大小写或冒号/空格分隔）",
      compareIdle: "输入期望摘要后将自动比对一致性",
      compareInvalidFormat: "期望值格式无效：提取十六进制字符后需为 64 位 SHA-256 摘要",
      compareMatch: "一致：计算结果与期望 SHA-256 完全匹配",
      compareMismatch: "不一致：计算结果与期望 SHA-256 不匹配",
      statusIdle: "尚未计算",
      statusRunning: (pct) => `正在流式读取计算（${pct}）…`,
      statusCompleted: "SHA-256 计算完成",
      statusCancelled: "计算已取消（未生成有效结果）",
      statusError: "计算失败",
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
  },
  "en-US": {
    appName: "WinKit",
    nav: {
      home: "All Tools",
      favorites: "Favorites",
      recent: "Recent",
      settings: "Settings",
      availableToolsHeading: "Available Tools",
    },
    categories: {
      all: "All Categories",
      developer: "Developer",
      image: "Images",
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
      drainingTitle: "Finishing Safely Before Exit…",
      errorTitle: "Unable to Complete Exit",
      body: (count, writeCount) =>
        writeCount > 0
          ? `${count} local task${count === 1 ? " is" : "s are"} still active (including ${writeCount} file-write commit step${writeCount === 1 ? "" : "s"}). WinKit does not run in the system tray; exiting will cancel interruptible tasks and wait for active file writes to finish safely.`
          : `${count} local task${count === 1 ? " is" : "s are"} currently running. WinKit does not continue in the system tray after closing; exiting now will cancel unfinished work and close once file handles are released.`,
      bodyFinished:
        "Active background tasks have finished. You can exit WinKit immediately or stay in your workspace.",
      drainingBody:
        "Stopping active tasks, completing atomic file cleanup, and releasing file handles…",
      timeoutBody: (remaining) =>
        `Timed out waiting for tasks to stop (still active: ${remaining}). WinKit kept the window open to avoid corrupting files; you can retry exiting or return to the workspace (cancelled tasks are not resumed).`,
      stayButton: "Stay in WinKit",
      quitAnywayButton: "Cancel Task & Exit",
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
      DISK_FULL: "Insufficient disk space on the target drive.",
      SIZE_LIMIT_EXCEEDED: "File size or canvas pixel dimensions exceed safety limits.",
      DECODE_FAILED: "Unable to decode file encoding or image format.",
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
      modeFile: "Local File",
      algorithmBadge: "SHA-256",
      scopeNote:
        "Phase 1 subset: UTF-8 text and streaming SHA-256 checksums for files of any size (additional algorithms scheduled for Phase 2).",
      textInputLabel: "Input Text",
      textPlaceholder: "Type or paste text to hash…",
      exactBytesNote:
        "Hashed as exact UTF-8 bytes: all leading/trailing spaces, tabs, and line breaks are preserved with no implicit trimming.",
      byteCount: (bytes) => `${bytes.toLocaleString()} UTF-8 bytes`,
      selectFileBtn: "Choose File…",
      dropFileHint:
        "Or drag and drop a file from File Explorer (streamed read-only; source file is never modified)",
      selectedFileLabel: "Selected File",
      fileSizeLabel: "File Size",
      computeBtn: "Recompute",
      cancelBtn: "Cancel",
      uppercaseLabel: "Uppercase hex",
      digestLabel: "SHA-256 Digest",
      copyBtn: "Copy Digest",
      copiedBadge: "Copied",
      clearBtn: "Clear",
      compareLabel: "Compare Expected SHA-256 (Optional)",
      comparePlaceholder:
        "Paste expected SHA-256 (accepts sha256: prefix, shasum output, uppercase, spaces, or colons)",
      compareIdle: "Enter an expected digest to verify integrity",
      compareInvalidFormat:
        "Invalid expected digest: must contain 64 hexadecimal characters for SHA-256",
      compareMatch: "Match: computed SHA-256 matches expected digest",
      compareMismatch: "Mismatch: computed SHA-256 does not match expected digest",
      statusIdle: "Ready",
      statusRunning: (pct) => `Streaming file (${pct})…`,
      statusCompleted: "SHA-256 completed",
      statusCancelled: "Cancelled (no valid digest retained)",
      statusError: "Hash computation failed",
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
  },
};
