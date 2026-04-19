'use client';

import { useEffect, useState } from 'react';

export default function PointsBadge({ walletAddress }: { walletAddress: string | undefined }) {
    const [points, setPoints] = useState<number | null>(null);
    const [showPoints, setShowPoints] = useState(true);
    const [justEarned, setJustEarned] = useState<number | null>(null);

    // 1. Fetch initial points
    useEffect(() => {
        if (!walletAddress) return;

        const fetchPoints = async () => {
            try {
                const res = await fetch(`/api/user/points?wallet=${walletAddress}`);
                const data = await res.json();
                if (data.points !== undefined) setPoints(data.points);
            } catch (error) {
                console.error("Failed to fetch AbaPoints:", error);
            }
        };
        fetchPoints();
    }, [walletAddress]);

    // 2. The Toggle Interval
    useEffect(() => {
        const interval = setInterval(() => {
            setShowPoints((prev) => !prev);
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    // 3. Listen for new points from the Payment page
    useEffect(() => {
        const handlePointsEarned = (e: any) => {
            const addedAmount = e.detail;
            setJustEarned(addedAmount);
            setPoints(prev => (prev || 0) + addedAmount);
            
            // Force it to show the points number immediately so they see it jump
            setShowPoints(true); 
            
            // Remove the glow after 3 seconds
            setTimeout(() => setJustEarned(null), 3000);
        };

        window.addEventListener('abapoints-awarded', handlePointsEarned);
        return () => window.removeEventListener('abapoints-awarded', handlePointsEarned);
    }, []);

    if (!walletAddress || points === null) return null;

    // Clean formatting (e.g., shows 1.50, but shows 2 instead of 2.00)
    const displayPoints = Number(points).toFixed(2).replace(/\.00$/, '');

    return (
        <div className="relative">
            <div className={`flex items-center justify-center min-w-[90px] h-8 bg-green-900/10 border border-green-500/50 rounded-full px-3 text-xs font-bold text-green-600 transition-all duration-500 ${justEarned ? 'shadow-[0_0_20px_rgba(34,197,94,0.8)] scale-110 bg-green-100' : 'shadow-[0_0_10px_rgba(34,197,94,0.4)]'}`}>
                <span className={`transition-opacity duration-500 ${showPoints ? 'opacity-100' : 'opacity-0 hidden'}`}>
                    ⚡ {displayPoints} 
                </span>
                <span className={`transition-opacity duration-500 ${!showPoints ? 'opacity-100' : 'opacity-0 hidden'}`}>
                    ✨ AbaPoints
                </span>
            </div>

            {/* ⚡ The Floating Dopamine Hit ⚡ */}
            {justEarned && (
                <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-emerald-500 font-black text-sm drop-shadow-md animate-out slide-out-to-top-8 fade-out duration-1000 fill-mode-forwards z-50">
                    +{justEarned.toFixed(2).replace(/\.00$/, '')}
                </div>
            )}
        </div>
    );
}
