// Core ↔ integrations interfaces (contracts/README.md §5). Plain types: these cross no network boundary.

export type ContactRef = { contactId: string; phone?: string; handle?: string };
export type BinInventorySnapshot = {
  snapshotId: string;
  binId: string;
  binType: "trash" | "recycling" | "compost";
  takenAt: string;
  estimatedFullness: number;
  items: { name: string; count: number }[];
  unknownCount: number;
};

export interface Illustrator {
  illustrate(
    snapshot: BinInventorySnapshot,
  ): Promise<{ imageUrl: string; generatedAt: string; snapshotId: string; mocked: boolean }>;
}
