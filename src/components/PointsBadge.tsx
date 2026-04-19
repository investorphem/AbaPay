'use client';

import { useEffect, useState } from 'react';

export default function PointsBadge({ walletAddress }: { walletAddress: string | undefined }) {
    const [points, setPoints] = useState<number | null>(null);
    const [showPoints, setShowPoints] = useState(true);

    // 1. Fetch the points from the database
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

    // 2. The Toggle Interval (Switches text every 3 seconds)
    useEffect(() => {
        const interval = setInterval(() => {
            setShowPoints((prev) => !prev);
        }, 3000);
        
        return () => clearInterval(interval);
    }, []);

    // Don't render until points are loaded
    if (!walletAddress || points === null) return null;

    return (
        <div className="flex items-center justify-center min-w-[90px] h-8 bg-green-900/10 border border-green-500/50 rounded-full px-3 text-xs font-bold text-green-600 shadow-[0_0_10px_rgba(34,197,94,0.4)] transition-all duration-300">
            <span className={`transition-opacity duration-500 ${showPoints ? 'opacity-100' : 'opacity-0 hidden'}`}>
                ⚡ {points} 
            </span>
            <span className={`transition-opacity duration-500 ${!showPoints ? 'opacity-100' : 'opacity-0 hidden'}`}>
                ✨ AbaPoints
            </span>
        </div>
    );
}
