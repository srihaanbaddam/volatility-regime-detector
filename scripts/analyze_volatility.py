import yfinance as yf
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import warnings
import sys
import json
import base64
from io import BytesIO
warnings.filterwarnings('ignore')
def get_data(ticker, start, end):
    data = yf.download(ticker, start=start, end=end, progress=False)
    if data.empty:
        raise ValueError(f"No data found for {ticker}")
    prices = data['Close'].squeeze()
    return prices

def calc_vol(prices, window=21):
    returns = prices.pct_change()
    vol = returns.rolling(window).std()
    ann_vol = vol * np.sqrt(252)
    return returns, vol, ann_vol


def hurst_dfa(ts):
    ts = np.array(ts)
    n = len(ts)
    if n < 20:
        return np.nan
    
    ts = ts - np.mean(ts)
    cumsum = np.cumsum(ts)
    scales, flucts = [], []
    
    for scale in range(4, min(n // 4, 30)):
        num_seg = n // scale
        if num_seg < 2:
            continue
        local_f = []
        for i in range(num_seg):
            seg = cumsum[i * scale:(i + 1) * scale]
            x = np.arange(scale)
            trend = np.polyval(np.polyfit(x, seg, 1), x)
            local_f.append(np.sqrt(np.mean((seg - trend) ** 2)))
        if local_f:
            scales.append(scale)
            flucts.append(np.mean(local_f))
    
    if len(scales) < 3:
        return np.nan
    try:
        slope, _ = np.polyfit(np.log(scales), np.log(flucts), 1)
        return np.clip(slope, 0.01, 0.99)
    except:
        return np.nan


def rolling_hurst(returns, window=63):
    ret = returns.dropna()
    hurst = []
    idx = []
    
    for i in range(window, len(ret)):
        seg = ret.iloc[i-window:i].values
        if np.all(np.isfinite(seg)):
            hurst.append(hurst_dfa(seg))
        else:
            hurst.append(np.nan)
        idx.append(ret.index[i])
    
    series = pd.Series(hurst, index=idx).interpolate(limit_direction='both')
    return series


def classify(vol, hurst):
    common = vol.index.intersection(hurst.index)
    v, h = vol.loc[common], hurst.loc[common]
    v_lo, v_hi, v_mid = v.quantile(0.33), v.quantile(0.66), v.quantile(0.5)
    
    # Absolute thresholds (annualized volatility)
    ABS_LOW_VOL = 0.15   # 15% - below this is objectively low
    ABS_MID_VOL = 0.30   # 30% - above this is never "Low Vol"
    ABS_HIGH_VOL = 0.50  # 50% - above this is always "High Vol"
    
    regimes = []
    for vi, hi in zip(v.values, h.values):
        if pd.isna(vi) or pd.isna(hi):
            regimes.append("Unknown")
        elif vi > ABS_HIGH_VOL:
            # Absolute override: very high volatility is always High Vol
            regimes.append("High Vol")
        elif vi > ABS_HIGH_VOL * 0.8 and hi > 0.55:
            # High volatility + trending = Trending
            regimes.append("Trending")
        elif vi < ABS_LOW_VOL and hi < 0.45:
            regimes.append("Calm")
        elif vi < v_lo and vi < ABS_LOW_VOL and hi < 0.45:
            # Relatively low AND below absolute threshold AND mean-reverting
            regimes.append("Calm")
        elif vi > v_hi and hi > 0.55:
            regimes.append("Trending")
        elif vi > v_hi or (hi > 0.55 and vi > v_mid):
            regimes.append("High Vol")
        elif vi < v_lo and vi < ABS_MID_VOL:
            # Only "Low Vol" if below absolute mid threshold
            regimes.append("Low Vol")
        else:
            regimes.append("Transition")
    
    return pd.Series(regimes, index=common)


def plot_regimes(ticker, prices, regimes, hurst, ann_vol):
    common = regimes.index
    p = prices.loc[prices.index.isin(common)]
    v = ann_vol.loc[ann_vol.index.isin(common)]
    h = hurst.loc[hurst.index.isin(common)]
    
    colors = {"Calm": "#2ecc71", "Low Vol": "#27ae60", "Trending": "#e74c3c",
              "High Vol": "#c0392b", "Transition": "#f39c12", "Unknown": "#95a5a6"}
    
    fig, axes = plt.subplots(4, 1, figsize=(16, 12), sharex=True)
    fig.suptitle(f'{ticker} Volatility Regime Detector', fontsize=16, fontweight='bold')
    
    axes[0].plot(p.index, p.values, 'b-', lw=1, label=ticker)
    for i in range(len(common) - 1):
        axes[0].axvspan(common[i], common[i+1], alpha=0.3, color=colors.get(regimes.iloc[i], 'gray'), lw=0)
    axes[0].set_ylabel('Price')
    axes[0].legend(loc='upper left')
    axes[0].grid(True, alpha=0.3)
    
    axes[1].fill_between(v.index, v.values, alpha=0.5, color='purple')
    axes[1].axhline(v.quantile(0.33), color='green', ls='--', alpha=0.7, label=f'Low ({v.quantile(0.33):.1%})')
    axes[1].axhline(v.quantile(0.66), color='red', ls='--', alpha=0.7, label=f'High ({v.quantile(0.66):.1%})')
    axes[1].set_ylabel('Volatility')
    axes[1].legend(loc='upper right', fontsize=8)
    axes[1].grid(True, alpha=0.3)
    axes[1].yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0%}'))
    
    axes[2].plot(h.index, h.values, 'darkorange', lw=1)
    axes[2].fill_between(h.index, h.values, 0.5, where=h.values > 0.5, alpha=0.3, color='red', label='Persistent')
    axes[2].fill_between(h.index, h.values, 0.5, where=h.values < 0.5, alpha=0.3, color='green', label='Mean-Reverting')
    axes[2].axhline(0.5, color='black', lw=1, label='Random Walk')
    axes[2].set_ylabel('Hurst')
    axes[2].set_ylim(0, 1)
    axes[2].legend(loc='upper right', fontsize=8)
    axes[2].grid(True, alpha=0.3)
    
    for i in range(len(common) - 1):
        axes[3].bar(common[i], 1, width=1, color=colors.get(regimes.iloc[i], 'gray'), alpha=0.8)
    axes[3].set_yticks([])
    patches = [mpatches.Patch(color=c, label=r) for r, c in colors.items() if r != "Unknown"]
    axes[3].legend(handles=patches, loc='upper right', ncol=3, fontsize=8)
    
    plt.xlabel('Date')
    plt.tight_layout()
    
    # Convert to base64
    buf = BytesIO()
    plt.savefig(buf, format='png', dpi=150, bbox_inches='tight')
    buf.seek(0)
    img_base64 = base64.b64encode(buf.read()).decode('utf-8')
    plt.close()
    
    return img_base64


def plot_stats(ticker, prices, regimes, vol):
    common = regimes.index
    returns = prices.loc[prices.index.isin(common)].pct_change()
    v = vol.loc[vol.index.isin(common)]
    
    colors = {"Calm": "#2ecc71", "Low Vol": "#27ae60", "Trending": "#e74c3c",
              "High Vol": "#c0392b", "Transition": "#f39c12"}
    unique = [r for r in regimes.unique() if r != "Unknown"]
    
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle(f'{ticker} Regime Statistics', fontsize=14, fontweight='bold')
    
    data = {r: v[regimes == r].mean() * np.sqrt(252) for r in unique}
    axes[0,0].bar(data.keys(), data.values(), color=[colors.get(r, 'gray') for r in data.keys()])
    axes[0,0].set_ylabel('Annualized Vol')
    axes[0,0].yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0%}'))
    plt.setp(axes[0,0].xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    data = {r: returns[regimes == r].mean() * 252 for r in unique}
    axes[0,1].bar(data.keys(), data.values(), color=[colors.get(r, 'gray') for r in data.keys()])
    axes[0,1].set_ylabel('Annualized Return')
    axes[0,1].axhline(0, color='black', lw=0.5)
    axes[0,1].yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'{x:.0%}'))
    plt.setp(axes[0,1].xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    data = {}
    for r in unique:
        ret = returns[regimes == r]
        if len(ret) > 0 and ret.std() > 0:
            data[r] = (ret.mean() * 252) / (ret.std() * np.sqrt(252))
    axes[1,0].bar(data.keys(), data.values(), color=[colors.get(r, 'gray') for r in data.keys()])
    axes[1,0].set_ylabel('Sharpe Ratio')
    axes[1,0].axhline(0, color='black', lw=0.5)
    plt.setp(axes[1,0].xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    durations = {r: [] for r in unique}
    curr, dur = regimes.iloc[0], 1
    for i in range(1, len(regimes)):
        if regimes.iloc[i] == curr:
            dur += 1
        else:
            if curr in durations:
                durations[curr].append(dur)
            curr, dur = regimes.iloc[i], 1
    # Don't forget the last duration if regime extends to end
    if curr in durations:
        durations[curr].append(dur)
    data = {r: np.mean(d) if d else 0 for r, d in durations.items()}
    axes[1,1].bar(data.keys(), data.values(), color=[colors.get(r, 'gray') for r in data.keys()])
    axes[1,1].set_ylabel('Avg Duration (Days)')
    plt.setp(axes[1,1].xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    plt.tight_layout()
    
    # Convert to base64
    buf = BytesIO()
    plt.savefig(buf, format='png', dpi=150, bbox_inches='tight')
    buf.seek(0)
    img_base64 = base64.b64encode(buf.read()).decode('utf-8')
    plt.close()
    
    return img_base64


def get_recommendation(regime):
    # Updated recommendations based on proper options Greeks understanding:
    # - Low vol = vol is cheap → buy options (long vega/gamma)
    # - High vol = vol is expensive → can sell premium, but hedge tail risk
    recs = {
        "Calm": ("Long Gamma", "Low", "Buy cheap options, straddles - vol is underpriced"),
        "Low Vol": ("Long Volatility", "Medium", "Buy options (vol is cheap), long straddles/strangles, avoid short gamma"),
        "Trending": ("Trend Following", "High", "Directional plays, momentum, consider debit spreads"),
        "High Vol": ("Short Volatility", "High", "Sell expensive premium, iron condors, credit spreads - but hedge tails"),
        "Transition": ("Neutral", "Medium", "Reduce size, delta-neutral strategies, wait for regime clarity")
    }
    return recs.get(regime, ("Unknown", "Unknown", "Insufficient data"))


def analyze(ticker, start, end, vol_window, hurst_window):
    prices = get_data(ticker, start, end)
    returns, vol, ann_vol = calc_vol(prices, vol_window)
    hurst = rolling_hurst(returns, hurst_window)
    regimes = classify(vol, hurst)
    
    regime_plot = plot_regimes(ticker, prices, regimes, hurst, ann_vol)
    stats_plot = plot_stats(ticker, prices, regimes, vol)
    
    curr_regime = regimes.iloc[-1]
    curr_vol = ann_vol.iloc[-1]
    curr_hurst = hurst.iloc[-1]
    strat, risk, desc = get_recommendation(curr_regime)
    
    result = {
        "regime": curr_regime,
        "volatility": f"{curr_vol:.2%}",
        "hurst": f"{curr_hurst:.3f}",
        "hurst_type": "Persistent" if curr_hurst > 0.5 else "Mean-Reverting",
        "strategy": strat,
        "risk": risk,
        "action": desc,
        "date": regimes.index[-1].strftime('%Y-%m-%d'),
        "regime_plot": regime_plot,
        "stats_plot": stats_plot
    }
    
    return result


if __name__ == "__main__":
    if len(sys.argv) != 6:
        print(json.dumps({"error": "Usage: python analyze_volatility.py <ticker> <start> <end> <vol_window> <hurst_window>"}))
        sys.exit(1)
    
    ticker = sys.argv[1]
    start = sys.argv[2]
    end = sys.argv[3]
    vol_window = int(sys.argv[4])
    hurst_window = int(sys.argv[5])
    
    try:
        result = analyze(ticker, start, end, vol_window, hurst_window)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)