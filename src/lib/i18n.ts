export const PORTAL_LOCALE_COOKIE = "pencilscope_locale";

export const portalLocales = [
  { code: "en", label: "English", nativeLabel: "English", intl: "en-SG" },
  { code: "zh-SG", label: "Mandarin Chinese", nativeLabel: "中文", intl: "zh-SG" },
  { code: "ms", label: "Malay", nativeLabel: "Bahasa Melayu", intl: "ms-SG" },
  { code: "ta", label: "Tamil", nativeLabel: "தமிழ்", intl: "ta-SG" }
] as const;

export type PortalLocale = typeof portalLocales[number]["code"];

export function portalLocale(value: unknown): PortalLocale {
  return portalLocales.some((locale) => locale.code === value) ? value as PortalLocale : "en";
}

export function localeFromCookies(cookies: { get(name: string): { value: string } | undefined }): PortalLocale {
  return portalLocale(cookies.get(PORTAL_LOCALE_COOKIE)?.value);
}

export function intlLocale(locale: PortalLocale): string {
  return portalLocales.find((item) => item.code === locale)?.intl ?? "en-SG";
}

const translations: Record<PortalLocale, Record<string, string>> = {
  en: {
    language: "Language", exploreLearning: "Explore learning", courses: "Courses", howItWorks: "How it works",
    myLearning: "My Learning", creatorStudio: "Creator Studio", learningMode: "Learning mode", creationMode: "Creation mode",
    network: "Network", notifications: "Notifications", viewAll: "View all", noNotifications: "No notifications yet.",
    profile: "Profile", preferences: "Preferences", actionHistory: "Action history", payments: "Payments",
    billingOperations: "Billing operations", signOut: "Sign out", logIn: "Log in", create: "Create", signUp: "Sign up",
    explore: "Explore", learning: "Learning", studio: "Studio", learn: "Learn", allLearning: "All learning",
    myResults: "My results", createContent: "Create content", createCourse: "Create a course", privacy: "Privacy",
    curiousMinds: "Curious minds grow here.", createdFor: "Created for curious people everywhere",
    searchLearning: "Search learning offers", searchPlaceholder: "Search by topic, format or creator", catalogueSearchPlaceholder: "Search by topic, skill, format or expert…", search: "Search",
    results: "learning results", result: "learning result", clearSearch: "Clear search", exploreAll: "Explore all learning →",
    noMatches: "No learning matches this search.", tryBroader: "Try a broader topic, creator or learning format.", showAll: "Show all learning",
    heroEyebrow: "Knowledge from real-world experience", heroTitle: "Knowledge Platform for everyone",
    heroCopy: "Learn from curated content created by experts who turn real-world experience into practical knowledge for everyone.",
    signUpFree: "Sign up free", browseBefore: "Browse before joining", freeAccount: "Free learner account", progressTogether: "Progress stays in one place",
    findLearning: "Find what you want to learn.", catalogueTitle: "Find learning that fits your goal.",
    catalogueCopy: "Browse expert-led courses, focused resources and curated bundles—with price and availability shown upfront.",
    learningType: "Learning type", singleResources: "Single resources", bundles: "Bundles", format: "Format", allFormats: "All formats",
    assessments: "Assessments", topic: "Topic", allTopics: "All topics", delivery: "Delivery", anyDelivery: "Any delivery",
    selfPaced: "Self-paced", liveOnline: "Live online", inPerson: "In person", hybrid: "Hybrid", availability: "Availability",
    anyAvailability: "Any availability", availableNow: "Available now", openingSoon: "Opening soon", sortBy: "Sort by",
    mostRelevant: "Most relevant", newest: "Newest", startingSoon: "Starting soon", priceLow: "Price: low to high",
    priceHigh: "Price: high to low", applyFilters: "Apply filters", clearFilters: "Clear all filters", languageFilter: "Content language",
    anyLanguage: "Any language", noFilterMatches: "No learning matches these filters", broadenFilters: "Try another language, topic or format, or clear the filters.",
    learnerHome: "Home", resultsNav: "Results", purchases: "Purchases", myProducts: "My Products", createProduct: "Create Product",
    pricingPublish: "Pricing & Publish", learners: "Learners", performance: "Performance", sales: "Sales", contentLibrary: "Content Library",
    activity: "Activity", settings: "Settings"
  },
  "zh-SG": {
    language: "语言", exploreLearning: "探索学习", courses: "课程", howItWorks: "使用方式", myLearning: "我的学习",
    creatorStudio: "创作者工作室", learningMode: "学习模式", creationMode: "创作模式", network: "人脉", notifications: "通知",
    viewAll: "查看全部", noNotifications: "暂无通知。", profile: "个人资料", preferences: "偏好设置", actionHistory: "操作记录",
    payments: "付款", billingOperations: "账务管理", signOut: "退出登录", logIn: "登录", create: "创建", signUp: "注册",
    explore: "探索", learning: "学习", studio: "工作室", learn: "学习", allLearning: "全部学习内容", myResults: "我的成绩",
    createContent: "创建内容", createCourse: "创建课程", privacy: "隐私", curiousMinds: "好奇心在这里成长。", createdFor: "为世界各地的求知者而创",
    searchLearning: "搜索学习内容", searchPlaceholder: "按主题、形式或创作者搜索", catalogueSearchPlaceholder: "按主题、技能、形式或专家搜索…", search: "搜索", results: "项学习结果", result: "项学习结果",
    clearSearch: "清除搜索", exploreAll: "探索全部学习内容 →", noMatches: "没有符合此搜索的学习内容。", tryBroader: "请尝试更广泛的主题、创作者或学习形式。",
    showAll: "显示全部学习内容", heroEyebrow: "来自真实经验的知识", heroTitle: "人人都能使用的知识平台",
    heroCopy: "向各领域专家学习精选内容，将真实经验转化为人人可用的实用知识。", signUpFree: "免费注册", browseBefore: "注册前即可浏览",
    freeAccount: "免费学习账户", progressTogether: "学习进度集中管理", findLearning: "找到您想学习的内容。", catalogueTitle: "找到适合您目标的学习内容。",
    catalogueCopy: "浏览专家课程、精选资源和组合内容，价格与可用情况一目了然。", learningType: "学习类型", singleResources: "单项资源", bundles: "组合内容",
    format: "形式", allFormats: "全部形式", assessments: "测验与考试", topic: "主题", allTopics: "全部主题", delivery: "授课方式",
    anyDelivery: "任何方式", selfPaced: "自主学习", liveOnline: "在线直播", inPerson: "线下", hybrid: "混合", availability: "可用情况",
    anyAvailability: "任何状态", availableNow: "现在可用", openingSoon: "即将开放", sortBy: "排序", mostRelevant: "最相关", newest: "最新",
    startingSoon: "即将开始", priceLow: "价格：从低到高", priceHigh: "价格：从高到低", applyFilters: "应用筛选", clearFilters: "清除全部筛选",
    languageFilter: "内容语言", anyLanguage: "任何语言", noFilterMatches: "没有符合筛选条件的内容", broadenFilters: "请尝试其他语言、主题或形式，或清除筛选。",
    learnerHome: "主页", resultsNav: "成绩", purchases: "购买记录", myProducts: "我的产品", createProduct: "创建产品", pricingPublish: "定价与发布",
    learners: "学习者", performance: "表现", sales: "销售", contentLibrary: "内容库", activity: "活动", settings: "设置"
  },
  ms: {
    language: "Bahasa", exploreLearning: "Teroka pembelajaran", courses: "Kursus", howItWorks: "Cara ia berfungsi", myLearning: "Pembelajaran Saya",
    creatorStudio: "Studio Pencipta", learningMode: "Mod pembelajaran", creationMode: "Mod penciptaan", network: "Rangkaian", notifications: "Pemberitahuan",
    viewAll: "Lihat semua", noNotifications: "Belum ada pemberitahuan.", profile: "Profil", preferences: "Keutamaan", actionHistory: "Sejarah tindakan",
    payments: "Bayaran", billingOperations: "Operasi bil", signOut: "Log keluar", logIn: "Log masuk", create: "Cipta", signUp: "Daftar",
    explore: "Teroka", learning: "Belajar", studio: "Studio", learn: "Belajar", allLearning: "Semua pembelajaran", myResults: "Keputusan saya",
    createContent: "Cipta kandungan", createCourse: "Cipta kursus", privacy: "Privasi", curiousMinds: "Minda ingin tahu berkembang di sini.", createdFor: "Dicipta untuk insan ingin tahu di mana-mana",
    searchLearning: "Cari tawaran pembelajaran", searchPlaceholder: "Cari mengikut topik, format atau pencipta", catalogueSearchPlaceholder: "Cari mengikut topik, kemahiran, format atau pakar…", search: "Cari", results: "hasil pembelajaran", result: "hasil pembelajaran",
    clearSearch: "Kosongkan carian", exploreAll: "Teroka semua pembelajaran →", noMatches: "Tiada pembelajaran sepadan dengan carian ini.", tryBroader: "Cuba topik, pencipta atau format pembelajaran yang lebih luas.",
    showAll: "Tunjukkan semua pembelajaran", heroEyebrow: "Ilmu daripada pengalaman dunia sebenar", heroTitle: "Platform Ilmu untuk semua",
    heroCopy: "Belajar daripada kandungan pilihan pakar yang mengubah pengalaman sebenar menjadi ilmu praktikal untuk semua.", signUpFree: "Daftar percuma",
    browseBefore: "Layari sebelum menyertai", freeAccount: "Akaun pelajar percuma", progressTogether: "Kemajuan di satu tempat", findLearning: "Cari apa yang anda mahu pelajari.",
    catalogueTitle: "Cari pembelajaran yang sesuai dengan matlamat anda.", catalogueCopy: "Layari kursus pakar, sumber terfokus dan himpunan pilihan dengan harga dan ketersediaan yang jelas.",
    learningType: "Jenis pembelajaran", singleResources: "Sumber tunggal", bundles: "Himpunan", format: "Format", allFormats: "Semua format", assessments: "Penilaian",
    topic: "Topik", allTopics: "Semua topik", delivery: "Penyampaian", anyDelivery: "Sebarang penyampaian", selfPaced: "Kendiri", liveOnline: "Dalam talian langsung",
    inPerson: "Bersemuka", hybrid: "Hibrid", availability: "Ketersediaan", anyAvailability: "Sebarang ketersediaan", availableNow: "Tersedia sekarang",
    openingSoon: "Dibuka tidak lama lagi", sortBy: "Susun mengikut", mostRelevant: "Paling berkaitan", newest: "Terbaharu", startingSoon: "Bermula tidak lama lagi",
    priceLow: "Harga: rendah ke tinggi", priceHigh: "Harga: tinggi ke rendah", applyFilters: "Gunakan penapis", clearFilters: "Kosongkan semua penapis",
    languageFilter: "Bahasa kandungan", anyLanguage: "Sebarang bahasa", noFilterMatches: "Tiada pembelajaran sepadan dengan penapis", broadenFilters: "Cuba bahasa, topik atau format lain, atau kosongkan penapis.",
    learnerHome: "Utama", resultsNav: "Keputusan", purchases: "Pembelian", myProducts: "Produk Saya", createProduct: "Cipta Produk", pricingPublish: "Harga & Terbit",
    learners: "Pelajar", performance: "Prestasi", sales: "Jualan", contentLibrary: "Pustaka Kandungan", activity: "Aktiviti", settings: "Tetapan"
  },
  ta: {
    language: "மொழி", exploreLearning: "கற்றலை ஆராயுங்கள்", courses: "பாடநெறிகள்", howItWorks: "இது எவ்வாறு செயல்படுகிறது", myLearning: "என் கற்றல்",
    creatorStudio: "உருவாக்குநர் அரங்கம்", learningMode: "கற்றல் முறை", creationMode: "உருவாக்க முறை", network: "வலையமைப்பு", notifications: "அறிவிப்புகள்",
    viewAll: "அனைத்தையும் காண்க", noNotifications: "அறிவிப்புகள் இல்லை.", profile: "சுயவிவரம்", preferences: "விருப்பங்கள்", actionHistory: "செயல் வரலாறு",
    payments: "கட்டணங்கள்", billingOperations: "கட்டண நிர்வாகம்", signOut: "வெளியேறு", logIn: "உள்நுழைக", create: "உருவாக்கு", signUp: "பதிவு செய்க",
    explore: "ஆராய்க", learning: "கற்றல்", studio: "அரங்கம்", learn: "கற்க", allLearning: "அனைத்து கற்றலும்", myResults: "என் முடிவுகள்",
    createContent: "உள்ளடக்கம் உருவாக்கு", createCourse: "பாடநெறி உருவாக்கு", privacy: "தனியுரிமை", curiousMinds: "ஆர்வமுள்ள மனங்கள் இங்கே வளர்கின்றன.", createdFor: "எங்குமுள்ள ஆர்வலர்களுக்காக உருவாக்கப்பட்டது",
    searchLearning: "கற்றல் வாய்ப்புகளைத் தேடுக", searchPlaceholder: "தலைப்பு, வடிவம் அல்லது உருவாக்குநர் மூலம் தேடுக", catalogueSearchPlaceholder: "தலைப்பு, திறன், வடிவம் அல்லது நிபுணர் மூலம் தேடுக…", search: "தேடுக", results: "கற்றல் முடிவுகள்", result: "கற்றல் முடிவு",
    clearSearch: "தேடலை அழி", exploreAll: "அனைத்து கற்றலையும் ஆராய்க →", noMatches: "இந்தத் தேடலுக்கு பொருத்தமான கற்றல் இல்லை.", tryBroader: "வேறு தலைப்பு, உருவாக்குநர் அல்லது கற்றல் வடிவத்தை முயற்சிக்கவும்.",
    showAll: "அனைத்து கற்றலையும் காட்டு", heroEyebrow: "உண்மை அனுபவத்திலிருந்து அறிவு", heroTitle: "அனைவருக்குமான அறிவுத் தளம்",
    heroCopy: "உண்மை அனுபவத்தை அனைவருக்கும் பயன்படும் நடைமுறை அறிவாக மாற்றும் நிபுணர்களின் தேர்ந்தெடுக்கப்பட்ட உள்ளடக்கத்திலிருந்து கற்றுக்கொள்ளுங்கள்.", signUpFree: "இலவசமாகப் பதிவு செய்க",
    browseBefore: "சேரும் முன் பார்வையிடுங்கள்", freeAccount: "இலவச கற்றல் கணக்கு", progressTogether: "முன்னேற்றம் ஒரே இடத்தில்", findLearning: "நீங்கள் கற்க விரும்புவதைக் கண்டறியுங்கள்.",
    catalogueTitle: "உங்கள் இலக்கிற்கு ஏற்ற கற்றலைக் கண்டறியுங்கள்.", catalogueCopy: "நிபுணர் பாடநெறிகள், பயனுள்ள வளங்கள் மற்றும் தொகுப்புகளை விலை மற்றும் கிடைக்கும் நிலையுடன் பார்வையிடுங்கள்.",
    learningType: "கற்றல் வகை", singleResources: "தனி வளங்கள்", bundles: "தொகுப்புகள்", format: "வடிவம்", allFormats: "அனைத்து வடிவங்கள்", assessments: "மதிப்பீடுகள்",
    topic: "தலைப்பு", allTopics: "அனைத்து தலைப்புகள்", delivery: "வழங்கல்", anyDelivery: "எந்த வழங்கலும்", selfPaced: "சுய வேகம்", liveOnline: "நேரடி இணையம்",
    inPerson: "நேரில்", hybrid: "கலப்பு", availability: "கிடைக்கும் நிலை", anyAvailability: "எந்த நிலையும்", availableNow: "இப்போது கிடைக்கும்", openingSoon: "விரைவில் திறக்கும்",
    sortBy: "வரிசைப்படுத்து", mostRelevant: "மிகவும் பொருத்தமானது", newest: "புதியது", startingSoon: "விரைவில் தொடங்கும்", priceLow: "விலை: குறைவிலிருந்து அதிகம்",
    priceHigh: "விலை: அதிகத்திலிருந்து குறைவு", applyFilters: "வடிகட்டிகளைப் பயன்படுத்து", clearFilters: "அனைத்து வடிகட்டிகளையும் அழி", languageFilter: "உள்ளடக்க மொழி",
    anyLanguage: "எந்த மொழியும்", noFilterMatches: "வடிகட்டிகளுக்கு பொருத்தமான கற்றல் இல்லை", broadenFilters: "வேறு மொழி, தலைப்பு அல்லது வடிவத்தை முயற்சிக்கவும் அல்லது வடிகட்டிகளை அழிக்கவும்.",
    learnerHome: "முகப்பு", resultsNav: "முடிவுகள்", purchases: "கொள்முதல்கள்", myProducts: "என் தயாரிப்புகள்", createProduct: "தயாரிப்பு உருவாக்கு",
    pricingPublish: "விலை & வெளியீடு", learners: "கற்பவர்கள்", performance: "செயல்திறன்", sales: "விற்பனை", contentLibrary: "உள்ளடக்க நூலகம்", activity: "செயல்பாடு", settings: "அமைப்புகள்"
  }
};

export function translator(locale: PortalLocale) {
  return (key: string): string => translations[locale][key] ?? translations.en[key] ?? key;
}
