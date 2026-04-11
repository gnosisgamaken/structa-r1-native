// Structa v0.4 — Cascade Edition
// Lightweight magical impact visualization for Rabbit R1

const nodes = {
    "core":     { x: 400, y: 150, label: "Core Cognition", color: "#a0b0ff", size: 28 },
    "memory":   { x: 180, y: 280, label: "Memory Index", color: "#7bffd1", size: 22 },
    "prompt":   { x: 620, y: 260, label: "Prompt Contract", color: "#ff9dff", size: 22 },
    "validator": { x: 280, y: 420, label: "Validator Layer", color: "#ffd47b", size: 20 },
    "output":   { x: 520, y: 420, label: "Card Output", color: "#7be3ff", size: 22 }
};

const edges = [
    ["core", "memory"], ["core", "prompt"], ["core", "validator"],
    ["memory", "validator"], ["prompt", "output"], ["validator", "output"]
];

let impacts = [];
let particles = [];
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const logEl = document.getElementById('log');

function log(text, type = '') {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    if (type) entry.classList.add(type);
    entry.innerHTML = `<span style="color:#555">[${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}]</span> ${text}`;
    logEl.appendChild(entry);
    if (logEl.children.length > 6) logEl.removeChild(logEl.children[0]);
    logEl.scrollTop = logEl.scrollHeight;
}

function drawNode(n, pulse = 1) {
    ctx.save();
    ctx.shadowBlur = 25;
    ctx.shadowColor = n.color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * pulse, 0, Math.PI * 2);
    ctx.fillStyle = n.color + '44';
    ctx.fill();
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.size * 0.6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.font = '500 13px Space Grotesk';
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'center';
    ctx.fillText(n.label, n.x, n.y + 48);
    ctx.restore();
}

function drawEdge(from, to, intensity = 1) {
    ctx.strokeStyle = `rgba(123, 140, 255, ${0.3 * intensity})`;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#7b8cff';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
}

function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // draw edges
    edges.forEach(([a,b]) => {
        const intensity = impacts.includes(b) || impacts.includes(a) ? 1.8 : 1;
        drawEdge(nodes[a], nodes[b], intensity);
    });
    
    // draw nodes
    Object.keys(nodes).forEach(key => {
        const pulse = impacts.includes(key) ? (1 + Math.sin(Date.now()/120) * 0.25) : 1;
        drawNode(nodes[key], pulse);
    });
    
    // simple particles for flow
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.fillRect(p.x, p.y, 3, 3);
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.022;
    });
    
    requestAnimationFrame(animate);
}

function triggerImpact(changedNode, affected) {
    impacts = [changedNode, ...affected];
    log(`<span class="impact">IMPACT</span> <span class="node">${changedNode}</span> triggered cascade → ${affected.join(', ')}`, 'impact');
    
    // create flow particles
    const start = nodes[changedNode];
    affected.forEach(targetKey => {
        const target = nodes[targetKey];
        for (let i = 0; i < 5; i++) {
            particles.push({
                x: start.x + (Math.random()-0.5)*30,
                y: start.y + (Math.random()-0.5)*30,
                vx: (target.x - start.x) / 22,
                vy: (target.y - start.y) / 22,
                life: 1.1,
                color: '#a0f'
            });
        }
    });
    
    setTimeout(() => { impacts = []; log('Cascade settled. State updated.'); }, 1800);
}

window.runTestCascade = function() {
    log('Running structured test cascade using v4 contract...');
    
    // Simulate a clean impact chain that follows the contract
    setTimeout(() => {
        log('Card received → job: patch, target: memory-index');
        triggerImpact("memory", ["validator", "core"]);
    }, 420);
    
    setTimeout(() => {
        log('Validator passed. No drift detected.');
        log('Output card generated (Mission Card format)');
    }, 1400);
};

window.exportBrief = function() {
    log('Exporting clean Brief (Markdown + structured delta)');
    const brief = `# Structa Cascade Brief\n\n**Project:** Atlas\n**Last Impact:** memory-index → validator, core\n**Status:** Stable | Confidence: 0.94\n\nApproved for next card.`;
    console.log(brief);
    alert('Brief exported to console (copy ready for Replit / R1)');
};

log('Structa v0.4 Cascade Engine booted.');
log('Minimalist log active — ready for testing.');
animate();
