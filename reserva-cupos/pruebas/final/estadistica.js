function resumir(valores) {
    if (valores.length < 2 || !valores.every(Number.isFinite)) throw new Error('Se requieren al menos dos mediciones finitas');
    const media = valores.reduce((s, v) => s + v, 0) / valores.length;
    const desvio = Math.sqrt(valores.reduce((s, v) => s + (v - media) ** 2, 0) / (valores.length - 1));
    return { muestras: valores.length, media, desvio };
}
function grafico(filas, propiedad, titulo) {
    const maximo = Math.max(1, ...filas.map(f => f[propiedad].media + f[propiedad].desvio));
    const y = v => 220 - v / maximo * 180;
    return `<h2>${titulo}</h2><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 280" role="img" aria-label="${titulo}">
        <path d="M50 20V220H680" fill="none" stroke="black"/>
        ${filas.map((f, i) => {
            const x = 140 + i * 200, d = f[propiedad];
            return `<rect x="${x - 35}" y="${y(d.media)}" width="70" height="${220 - y(d.media)}" fill="#2463eb"/>
            <path d="M${x} ${y(d.media + d.desvio)}V${y(Math.max(0, d.media - d.desvio))} M${x - 12} ${y(d.media + d.desvio)}h24" stroke="black"/>
            <text x="${x - 60}" y="20">${d.media.toFixed(2)} +/- ${d.desvio.toFixed(2)}</text>
            <text x="${x - 20}" y="250">${f.apis} API</text>`;
        }).join('')}</svg>`;
}
module.exports = { resumir, grafico };
