// Structa v0.5 — Bauhaus Hexagon Edition
// Pure SVG + CSS. Premium geometric animation for Rabbit R1

const symbols = {
    core:      { sym: "⬡", color: "#9f1d35", label: "CORE" },
    memory:    { sym: "⧈", color: "#e3a857", label: "MEMORY" },
    contract:  { sym: "△", color: "#1e4b7c", label: "CONTRACT" },
    validator: { sym: "✕", color: "#f4f4f0", label: "VALIDATOR" },
    output:    { sym: "◆", color: "#d9c2a3", label: "OUTPUT" }
};

const connections = [
    ["core", "memory"], ["core", "contract"], ["core", "validator"],
    ["memory", "validator"], ["contract", "output"], ["validator", "output"]
];

let activeImpacts = new Set();
const svg = document.getElementById('graph');
const logEl = document.getElementById('log');

function log(text, cls = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${cls}`;
    entry.innerHTML = `<span style="color:#555">[${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}]</span> ${text}`;
    logEl.appendChild(entry);
    if (logEl.children.length > 7) logEl.removeChild(logEl.children[0]);
    logEl.scrollTop = 9999;
}

function createHex(x, y, key) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "hex");
    g.setAttribute("data-node", key);

    const hex = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    const size = 58;
    const points = [];
    for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + size * Math.cos(ang);
        const py = y + size * Math.sin(ang);
        points.push(`${px},${py}`);
    }
    hex.setAttribute("points", points.join(" "));
    hex.setAttribute("fill", "none");
    hex.setAttribute("stroke", symbols[key].color);
    hex.setAttribute("stroke-width", "3.5");
    hex.setAttribute("stroke-linejoin", "round");

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", x);
    text.setAttribute("y", y + 4);
    text.setAttribute("class", "symbol");
    text.setAttribute("fill", symbols[key].color);
    text.textContent = symbols[key].sym;

    g.appendChild(hex);
    g.appendChild(text);
    svg.appendChild(g);

    return g;
}

function drawConnections() {
    connections.forEach(([from, to]) => {
        const g1 = document.querySelector(`[data-node="${from}"]`);
        const g2 = document.querySelector(`[data-node="${to}"]`);
        if (!g1 || !g2) return;

        const x1 = parseFloat(g1.querySelector('polygon').getAttribute('points').split(' ')[0].split(',')[0]);
        const y1 = parseFloat(g1.querySelector('polygon').getAttribute('points').split(' ')[0].split(',')[1]);
        const x2 = parseFloat(g2.querySelector('polygon').getAttribute('points').split(' ')[0].split(',')[0]);
        const y2 = parseFloat(g2.querySelector('polygon').getAttribute('points').split(' ')[0].split(',')[1]);

        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", "#555");
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-dasharray", "20 8");
        line.setAttribute("stroke-dashoffset", "0");
        svg.insertBefore(line, svg.firstChild);
    });
}

function animateCascade(impacted) {
    impacted.forEach(key => {
        const group = document.querySelector(`[data-node="${key}"]`);
        if (!group) return;
        activeImpacts.add(key);
        group.style.transform = "scale(1.18)";
        setTimeout(() => group.style.transform = "scale(1)", 620);
    });

    log(`<span style="color:#e3a857">CASCADE</span> ${impacted.join(" → ")}`, "impact");
    
    setTimeout(() => {
        activeImpacts.clear();
        log("Cascade complete. State stabilized. Bauhaus integrity maintained.");
    }, 1200);
}

window.runTestCascade = function() {
    log("v0.5 contract loaded — executing clean impact chain...");

    setTimeout(() => {
        log("Mission Card received → patch on Memory Index");
        animateCascade(["memory", "validator", "core"]);
    }, 380);

    setTimeout(() => {
        log("Validator passed. Zero drift.");
        log("Output rendered as Decision Card.");
    }, 1250);
};

// Initialize
function init() {
    const positions = {
        core:      [230, 130],
        memory:    [100, 240],
        contract:  [360, 240],
        validator: [160, 370],
        output:    [300, 370]
    };

    Object.keys(positions).forEach(key => {
        createHex(...positions[key], key);
    });

    drawConnections();

    log("Structa v0.5 Bauhaus Hexagon booted.");
    log("Pure SVG geometry. Premium. Calm. R1-native.");
}

init();
