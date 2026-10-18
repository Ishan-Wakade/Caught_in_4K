/**
 * Figures and sources for the "Why it matters" page. Every number on that page comes from here and names its source,
 * so a figure and its citation can't drift apart. Read and checked 18 Oct 2026; each entry notes the year its data
 * describes, which is often older than the publication.
 */

export type Source = {
  id: string;
  /** Publisher or authors, as shown in the source list. */
  by: string;
  title: string;
  /** Where and when it was published, plus the year the data describes when that differs. */
  detail: string;
  url: string;
};

export const SOURCES = [
  {
    id: "epa-ff",
    by: "U.S. Environmental Protection Agency",
    title: "National Overview: Facts and Figures on Materials, Wastes and Recycling",
    detail: "Data for calendar year 2018, the latest national edition; page updated 19 Dec 2025.",
    url: "https://www.epa.gov/facts-and-figures-about-materials-waste-and-recycling/national-overview-facts-and-figures-materials",
  },
  {
    id: "trp-2024",
    by: "The Recycling Partnership",
    title: "2024 State of Recycling: The Present and Future of Residential Recycling in the U.S.",
    detail: "January 2024.",
    url: "https://recyclingpartnership.org/residential-recycling-report-2024/",
  },
  {
    id: "trp-2020",
    by: "The Recycling Partnership",
    title: "2020 State of Curbside Recycling Report",
    detail: "February 2020. The 17% average comes from the roughly one in three communities that track inbound contamination.",
    url: "https://recyclingpartnership.org/wp-content/uploads/dlm_uploads/2020/02/2020-State-of-Curbside-Recycling.pdf",
  },
  {
    id: "oecd-plastics",
    by: "OECD",
    title: "Global Plastics Outlook: Economic Drivers, Environmental Impacts and Policy Options",
    detail: "February 2022; 2019 data.",
    url: "https://www.oecd.org/en/about/news/press-releases/2022/02/plastic-pollution-is-growing-relentlessly-as-waste-management-and-recycling-fall-short.html",
  },
  {
    id: "epa-lmop",
    by: "U.S. Environmental Protection Agency, Landfill Methane Outreach Program",
    title: "Basic Information about Landfill Gas",
    detail: "2022 emissions; page updated 1 Sep 2026.",
    url: "https://www.epa.gov/lmop/basic-information-about-landfill-gas",
  },
  {
    id: "kab-2025",
    by: "Keep America Beautiful and The Harris Poll",
    title: "Americans Overwhelmingly Support Recycling, Yet Rates Remain Stubbornly Low and Many Don't Get It Right",
    detail: "3 Nov 2025. Online survey of 2,070 U.S. adults, 9–14 Oct 2025.",
    url: "https://kab.org/americans-overwhelmingly-support-recycling-yet-rates-remain-stubbornly-low-and-many-dont-get-it-right/",
  },
  {
    id: "kab-2024",
    by: "Keep America Beautiful and The Harris Poll",
    title: "Americans Want to Recycle but Worry About Getting It Right",
    detail: "14 Nov 2024. Online survey of 2,075 U.S. adults, 3–7 Oct 2024.",
    url: "https://kab.org/americans-want-to-recycle-but-worry-about-getting-it-right/",
  },
  {
    id: "lotti-2023",
    by: "Lotti, L., Barile, L. & Manfredi, G.",
    title: "Improving recycling sorting behaviour with human eye nudges",
    detail: "Scientific Reports 13, 10127 (2023). Nine-week quasi-experiment in two buildings of a UK university campus.",
    url: "https://doi.org/10.1038/s41598-023-37019-x",
  },
  {
    id: "luo-2019",
    by: "Luo, Y., Zelenika, I. & Zhao, J.",
    title: "Providing immediate feedback improves recycling and composting accuracy",
    detail: "Journal of Environmental Management 232, 445–454 (2019).",
    url: "https://doi.org/10.1016/j.jenvman.2018.11.061",
  },
  {
    id: "ackerman-2026",
    by: "Ackerman, A., Davis, A., Rainwater, E. & Mullen, R.",
    title: "Sound advice? The effect of an auditory prompt on recycling contamination",
    detail: "Social Sciences & Humanities Open 14, 103139 (2026). Randomized field trial at 24 locations over 30 days.",
    url: "https://doi.org/10.1016/j.ssaho.2026.103139",
  },
  {
    id: "cambridge",
    by: "City of Cambridge Department of Public Works",
    title: "Your guide to trash, recycle, compost, and more! (2022/2023) and Recycling",
    detail: "Read 17 Oct 2026; the same rules the voice guide uses in the demo.",
    url: "https://www.cambridgema.gov/services/recycling",
  },
] as const satisfies readonly Source[];

export type SourceId = (typeof SOURCES)[number]["id"];

/** 1-based number of a source in the list, as printed in its citation mark. */
export function sourceNumber(id: SourceId): number {
  return SOURCES.findIndex((s) => s.id === id) + 1;
}

export type Stat = { text: string; label: string; source: SourceId };

/** The headline figures: what escapes recycling, what contaminates it, and what the landfill costs the climate. */
export const NUMBERS: Stat[] = [
  { text: "1 in 5", label: "recyclables from U.S. homes actually gets recycled", source: "trp-2024" },
  { text: "1 in 6", label: "pounds of what goes in recycling bins doesn't belong there", source: "trp-2020" },
  { text: "24%", label: "of what goes to U.S. landfills is food, more than any other material", source: "epa-ff" },
  { text: "14.4%", label: "of U.S. human-caused methane came from landfills in 2022, the third-biggest source", source: "epa-lmop" },
];

export type Slice = { key: "landfill" | "burned" | "recycled" | "composted" | "other"; label: string; value: number; note?: string };
export type Breakdown = { id: string; tab: string; title: string; unit: string; total: string; slices: Slice[]; source: SourceId };

/** Shared by every breakdown, so a destination keeps its colour when the tab changes. */
export const SLICE_COLOR: Record<Slice["key"], string> = {
  landfill: "#5A5C58",
  burned: "#C8694A",
  recycled: "#4A77A3",
  composted: "#4A8539",
  other: "#8A6AA0",
};

export const BREAKDOWNS: Breakdown[] = [
  {
    id: "us",
    tab: "What Americans throw away",
    title: "Where Americans' trash went in 2018",
    unit: "million tons",
    total: "292 million tons, about 5 pounds per person every day",
    source: "epa-ff",
    slices: [
      { key: "landfill", label: "Buried in a landfill", value: 146.1 },
      { key: "burned", label: "Burned to make energy", value: 34.6 },
      { key: "recycled", label: "Recycled", value: 69.0 },
      { key: "composted", label: "Composted", value: 24.9 },
      { key: "other", label: "Food sent elsewhere, like animal feed", value: 17.7 },
    ],
  },
  {
    id: "plastic",
    tab: "Plastic, worldwide",
    title: "Where the world's plastic waste went in 2019",
    unit: "% of plastic waste",
    total: "353 million metric tons",
    source: "oecd-plastics",
    slices: [
      { key: "landfill", label: "Buried in a landfill", value: 50 }, // OECD: "almost 50%"
      { key: "burned", label: "Burned in incinerators", value: 19 },
      { key: "recycled", label: "Recycled", value: 9 },
      { key: "other", label: "Dumped, burned in the open, or left in nature", value: 22 },
    ],
  },
];

export type Belief = { n: number; of100: string; source: SourceId };

/** Survey findings, phrased "out of 100 U.S. adults" for the people grid. Rounded to the nearest person. */
export const BELIEFS: Belief[] = [
  { n: 87, of100: "say recycling is important", source: "kab-2025" },
  { n: 62, of100: "think they're good at recycling, yet fewer than half know how to recycle a bottle cap", source: "kab-2025" },
  { n: 55, of100: "wrongly think compostable items go in recycling with cans and bottles", source: "kab-2025" },
  { n: 41, of100: "have put items in the trash to avoid the risk of recycling them wrong", source: "kab-2024" },
  { n: 33, of100: "feel anxious trying to work out which items are recyclable", source: "kab-2024" },
];

export type Bin = "recycle" | "compost" | "trash" | "none";

export type QuizItem = { item: string; emoji: string; bin: Bin; place: string; reason: string };

/** The first word of the spoken guidance, as the voice guide says it. */
export const BIN_WORD: Record<Bin, string> = { recycle: "Recycling", compost: "Compost", trash: "Trash", none: "None" };

/** Cambridge, MA curbside rules (worker/rules/cambridge-ma-2022.md): only items those rules decide outright. */
export const QUIZ: QuizItem[] = [
  { item: "Chicken bones", emoji: "🍗", bin: "compost", place: "compost", reason: "Cambridge compost takes all food scraps, even meat and bones" },
  { item: "Rinsed peanut butter jar", emoji: "🥜", bin: "recycle", place: "recycling", reason: "rinsed jars and plastic containers are recyclable in Cambridge" },
  { item: "Torn T-shirt", emoji: "👕", bin: "none", place: "a textile donation bin", reason: "Massachusetts bans textiles from the trash, even torn or stained ones" },
  { item: "Used paper towel", emoji: "🧻", bin: "compost", place: "compost", reason: "paper towels go in compost, not recycling, in Cambridge" },
  { item: "Candy wrapper", emoji: "🍬", bin: "trash", place: "trash", reason: "wrappers aren't accepted in Cambridge recycling or compost" },
  { item: "Plastic shopping bag", emoji: "🛍️", bin: "none", place: "the Recycle Center", reason: "Cambridge recycling carts don't take plastic bags or film" },
]

/** "Compost. Chicken bones should be placed in compost because Cambridge compost takes all food scraps, even meat and bones." */
export function spoken(q: QuizItem): string {
  return `${BIN_WORD[q.bin]}. ${q.item} should be placed in ${q.place} because ${q.reason}.`;
}
