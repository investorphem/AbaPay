'use client';

import { useEffect, useState } from 'react';

export default function PointsBadge({ walletAddress }: { walletAddress: string | undefined }) {
    const [points, setPoints] = useState<number | null>(null);

    useEffect(() => {
        if (!walletAddress) return;

        const fetchPoints = async () => {
            try {
                const res = await fetch(`/api/user/points?wallet=${walletAddress}`);
                const data = await res.json();
                
                if (data.points !== undefined) {
                    setPoints(data.points);
                }
            } catch (error) {
                console.error("Failed to fetch AbaPoints:", error);
            }
        };

        fetchPoints();
    }, [walletAddress]);

    // Don't render anything if the wallet isn't connected or points haven't loaded
    if (!walletAddress || points === null) return null;

    return (
        <div className="flex items-center gap-1.5 bg-green-100 text-green-800 border border-green-200 px-3 py-1 rounded-full font-bold text-sm shadow-sm transition-all hover:scale-105">
            <span>⚡</span>
            <span>{points} Points</span>
        </div>
    );
}
