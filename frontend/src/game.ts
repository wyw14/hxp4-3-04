import type {
  GameState,
  AnchorPoint,
  Connection,
  DrawState,
  ScreenPoint,
  CurvePoint,
  BackgroundStar,
  LevelData
} from './types';
import { Renderer } from './renderer';
import { getLevel, verifyEdge } from './api';
import {
  generateBackgroundStars,
  smoothPath,
  simplifyPath,
  distance,
  clamp
} from './utils';

const SNAP_DISTANCE = 35;
const SAMPLE_INTERVAL = 16;

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private state: GameState;
  private backgroundStars: BackgroundStar[] = [];
  private lastTime: number = 0;
  private animationFrameId: number = 0;
  private listeners: Array<() => void> = [];
  private completionTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private onLevelChange?: (level: LevelData) => void;
  private onProgressChange?: (current: number, total: number) => void;
  private onComplete?: (desc: string) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);

    this.state = {
      currentLevel: 1,
      levelData: null,
      connections: [],
      completedEdges: new Set(),
      drawState: this.createEmptyDrawState(),
      rotationOffset: 0,
      time: 0,
      showFrequencies: false,
      isComplete: false,
      snapTargetId: null,
      keyboardMode: false,
      keyboardFocusId: null,
      keyboardStartId: null,
      keyboardPreviewLine: null,
      isVerifying: false,
      feedbackShake: null
    };

    this.resize();
    this.bindEvents();
  }

  private createEmptyDrawState(): DrawState {
    return {
      isDrawing: false,
      startAnchorId: null,
      currentPos: null,
      points: [],
      lastSampleTime: 0
    };
  }

  setCallbacks(callbacks: {
    onLevelChange?: (level: LevelData) => void;
    onProgressChange?: (current: number, total: number) => void;
    onComplete?: (desc: string) => void;
  }): void {
    this.onLevelChange = callbacks.onLevelChange;
    this.onProgressChange = callbacks.onProgressChange;
    this.onComplete = callbacks.onComplete;
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.resize(w, h);
    this.backgroundStars = generateBackgroundStars(400, w, h);
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.handleMouseUp());

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.handleMouseDown({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.handleMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    });
    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.handleMouseUp();
    });

    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  private getCanvasPos(e: MouseEvent): ScreenPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  private findNearestAnchor(pos: ScreenPoint): AnchorPoint | null {
    if (!this.state.levelData) return null;

    let nearest: AnchorPoint | null = null;
    let nearestDist = Infinity;

    for (const anchor of this.state.levelData.anchorPoints) {
      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const d = distance(pos, anchorPos);

      if (d < SNAP_DISTANCE && d < nearestDist) {
        const isValidAnchor = anchor.id.startsWith('a') || anchor.id.startsWith('b') || anchor.id.startsWith('c');
        if (isValidAnchor) {
          nearest = anchor;
          nearestDist = d;
        }
      }
    }

    return nearest;
  }

  private getMainAnchors(): AnchorPoint[] {
    if (!this.state.levelData) return [];
    return this.state.levelData.anchorPoints.filter(a =>
      a.id.startsWith('a') || a.id.startsWith('b') || a.id.startsWith('c')
    );
  }

  private findNextAnchorByDirection(direction: 'up' | 'down' | 'left' | 'right'): AnchorPoint | null {
    const anchors = this.getMainAnchors();
    if (anchors.length === 0) return null;

    const currentFocusId = this.state.keyboardFocusId;
    if (!currentFocusId) {
      return this.findClosestToCenterAnchor();
    }

    const currentAnchor = anchors.find(a => a.id === currentFocusId);
    if (!currentAnchor) return this.findClosestToCenterAnchor();

    const currentPos = this.renderer.getAnchorScreenPos(currentAnchor, this.state.rotationOffset);

    let bestAnchor: AnchorPoint | null = null;
    let bestScore = Infinity;

    for (const anchor of anchors) {
      if (anchor.id === currentFocusId) continue;

      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const dx = anchorPos.x - currentPos.x;
      const dy = anchorPos.y - currentPos.y;

      let directionMatch = 0;
      let perpendicularDist = 0;

      switch (direction) {
        case 'up':
          directionMatch = -dy;
          perpendicularDist = Math.abs(dx);
          break;
        case 'down':
          directionMatch = dy;
          perpendicularDist = Math.abs(dx);
          break;
        case 'left':
          directionMatch = -dx;
          perpendicularDist = Math.abs(dy);
          break;
        case 'right':
          directionMatch = dx;
          perpendicularDist = Math.abs(dy);
          break;
      }

      if (directionMatch <= 0) continue;

      const score = perpendicularDist * 2 + directionMatch * 0.5;

      if (score < bestScore) {
        bestScore = score;
        bestAnchor = anchor;
      }
    }

    if (!bestAnchor) {
      return this.findFallbackAnchor(direction, currentPos, anchors, currentFocusId);
    }

    return bestAnchor;
  }

  private findClosestToCenterAnchor(): AnchorPoint | null {
    const anchors = this.getMainAnchors();
    if (anchors.length === 0) return null;

    const center = this.renderer.getCenter();
    let nearest: AnchorPoint | null = null;
    let nearestDist = Infinity;

    for (const anchor of anchors) {
      const pos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const d = distance(pos, center);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = anchor;
      }
    }

    return nearest;
  }

  private findFallbackAnchor(
    direction: 'up' | 'down' | 'left' | 'right',
    currentPos: ScreenPoint,
    anchors: AnchorPoint[],
    excludeId: string
  ): AnchorPoint | null {
    let bestAnchor: AnchorPoint | null = null;
    let bestScore = Infinity;

    for (const anchor of anchors) {
      if (anchor.id === excludeId) continue;

      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const dx = anchorPos.x - currentPos.x;
      const dy = anchorPos.y - currentPos.y;

      let score = Infinity;

      switch (direction) {
        case 'up':
          score = Math.abs(dy) + Math.abs(dx) * 0.5 + (dy > 0 ? 1000 : 0);
          break;
        case 'down':
          score = Math.abs(dy) + Math.abs(dx) * 0.5 + (dy < 0 ? 1000 : 0);
          break;
        case 'left':
          score = Math.abs(dx) + Math.abs(dy) * 0.5 + (dx > 0 ? 1000 : 0);
          break;
        case 'right':
          score = Math.abs(dx) + Math.abs(dy) * 0.5 + (dx < 0 ? 1000 : 0);
          break;
      }

      if (score < bestScore) {
        bestScore = score;
        bestAnchor = anchor;
      }
    }

    return bestAnchor;
  }

  private async handleKeyDown(e: KeyboardEvent): Promise<void> {
    if (this.state.isComplete) return;

    const key = e.key;

    if (key === 'Tab') {
      e.preventDefault();
      this.toggleKeyboardMode();
      return;
    }

    if (!this.state.keyboardMode) return;

    e.preventDefault();

    if (this.state.isVerifying) return;

    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        this.handleArrowKey(key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right');
        break;
      case 'Enter':
      case ' ':
        await this.handleKeyboardSelect();
        break;
      case 'Escape':
        this.cancelKeyboardSelection();
        break;
    }
  }

  private toggleKeyboardMode(): void {
    this.state.keyboardMode = !this.state.keyboardMode;

    if (this.state.keyboardMode) {
      const anchor = this.findClosestToCenterAnchor();
      if (anchor) {
        this.state.keyboardFocusId = anchor.id;
      }
    } else {
      this.cancelKeyboardSelection();
    }
  }

  private handleArrowKey(direction: 'up' | 'down' | 'left' | 'right'): void {
    const nextAnchor = this.findNextAnchorByDirection(direction);
    if (nextAnchor) {
      this.state.keyboardFocusId = nextAnchor.id;

      if (this.state.keyboardStartId && this.state.keyboardStartId !== nextAnchor.id) {
        this.state.keyboardPreviewLine = {
          from: this.state.keyboardStartId,
          to: nextAnchor.id
        };
      } else {
        this.state.keyboardPreviewLine = null;
      }
    }
  }

  private async handleKeyboardSelect(): Promise<void> {
    if (!this.state.keyboardFocusId || this.state.isVerifying) return;

    if (!this.state.keyboardStartId) {
      this.state.keyboardStartId = this.state.keyboardFocusId;
      this.state.keyboardPreviewLine = null;
    } else if (this.state.keyboardStartId !== this.state.keyboardFocusId) {
      this.state.isVerifying = true;
      try {
        const result = await this.createConnectionBetween(
          this.state.keyboardStartId,
          this.state.keyboardFocusId
        );
        if (result === 'duplicate') {
          this.triggerShakeFeedback([this.state.keyboardStartId, this.state.keyboardFocusId]);
        }
      } finally {
        this.state.isVerifying = false;
      }
      this.state.keyboardStartId = null;
      this.state.keyboardPreviewLine = null;
    } else {
      this.state.keyboardStartId = null;
      this.state.keyboardPreviewLine = null;
    }
  }

  private triggerShakeFeedback(anchorIds: string[]): void {
    this.state.feedbackShake = {
      ids: anchorIds,
      intensity: 8,
      startTime: performance.now()
    };
  }

  private cancelKeyboardSelection(): void {
    if (this.state.isVerifying) return;
    this.state.keyboardStartId = null;
    this.state.keyboardPreviewLine = null;
  }

  private async createConnectionBetween(
    fromId: string,
    toId: string
  ): Promise<'success' | 'invalid' | 'duplicate'> {
    if (!this.state.levelData) return 'invalid';

    const edgeKey = [fromId, toId].sort().join('-');
    const alreadyConnected = this.state.completedEdges.has(edgeKey);

    if (alreadyConnected) {
      return 'duplicate';
    }

    const startAnchor = this.state.levelData.anchorPoints.find(a => a.id === fromId)!;
    const endAnchor = this.state.levelData.anchorPoints.find(a => a.id === toId)!;

    const startPos = this.renderer.getAnchorScreenPos(startAnchor, this.state.rotationOffset);
    const endPos = this.renderer.getAnchorScreenPos(endAnchor, this.state.rotationOffset);

    const midX = (startPos.x + endPos.x) / 2 + (Math.random() - 0.5) * 40;
    const midY = (startPos.y + endPos.y) / 2 + (Math.random() - 0.5) * 40;

    const rawPoints: CurvePoint[] = [
      { x: startPos.x, y: startPos.y },
      { x: midX, y: midY, t: 0.5 },
      { x: endPos.x, y: endPos.y }
    ];

    const smoothed = smoothPath(rawPoints, 0.4);

    const curvePoints: CurvePoint[] = [
      { x: startPos.x, y: startPos.y },
      ...smoothed.slice(1, -1),
      { x: endPos.x, y: endPos.y }
    ];

    const result = await verifyEdge(this.state.currentLevel, fromId, toId);

    const connection: Connection = {
      from: fromId,
      to: toId,
      curve: curvePoints,
      valid: result.valid,
      opacity: 0,
      glowIntensity: 0
    };

    this.state.connections.push(connection);
    this.animateConnection(connection);

    if (result.valid) {
      this.state.completedEdges.add(edgeKey);
      this.checkCompletion();
      return 'success';
    } else {
      setTimeout(() => {
        this.removeConnection(fromId, toId);
      }, 1500);
      return 'invalid';
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    if (this.state.isComplete) return;

    const pos = this.getCanvasPos(e);
    const anchor = this.findNearestAnchor(pos);

    if (anchor) {
      this.state.drawState = {
        isDrawing: true,
        startAnchorId: anchor.id,
        currentPos: pos,
        points: [],
        lastSampleTime: performance.now()
      };
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const pos = this.getCanvasPos(e);

    if (this.state.drawState.isDrawing) {
      const now = performance.now();
      if (now - this.state.drawState.lastSampleTime >= SAMPLE_INTERVAL) {
        this.state.drawState.points.push({ x: pos.x, y: pos.y });
        this.state.drawState.lastSampleTime = now;
      }
      this.state.drawState.currentPos = pos;

      const endAnchor = this.findNearestAnchor(pos);
      this.state.snapTargetId = (endAnchor && endAnchor.id !== this.state.drawState.startAnchorId)
        ? endAnchor.id
        : null;
    } else {
      const anchor = this.findNearestAnchor(pos);
      this.state.snapTargetId = anchor ? anchor.id : null;
    }
  }

  private async handleMouseUp(): Promise<void> {
    if (!this.state.drawState.isDrawing || !this.state.levelData || this.state.isVerifying) {
      this.state.drawState = this.createEmptyDrawState();
      return;
    }

    const ds = this.state.drawState;
    const startId = ds.startAnchorId!;
    let endPos = ds.currentPos;

    if (ds.points.length > 0 && endPos) {
      endPos = this.state.snapTargetId
        ? this.renderer.getAnchorScreenPos(
            this.state.levelData.anchorPoints.find(a => a.id === this.state.snapTargetId)!,
            this.state.rotationOffset
          )
        : ds.points[ds.points.length - 1];
    }

    const endAnchor = this.findNearestAnchor(endPos ?? { x: 0, y: 0 });
    const endId = endAnchor?.id;

    if (startId && endId && startId !== endId) {
      const edgeKey = [startId, endId].sort().join('-');
      const alreadyConnected = this.state.completedEdges.has(edgeKey);

      if (!alreadyConnected) {
        const startAnchor = this.state.levelData.anchorPoints.find(a => a.id === startId)!;
        const startPos = this.renderer.getAnchorScreenPos(startAnchor, this.state.rotationOffset);

        let curvePoints: CurvePoint[] = [{ x: startPos.x, y: startPos.y }, ...ds.points];
        if (endPos) curvePoints.push(endPos);

        curvePoints = simplifyPath(curvePoints, 5);
        curvePoints = smoothPath(curvePoints, 0.5);

        curvePoints[0] = { x: startPos.x, y: startPos.y };
        curvePoints[curvePoints.length - 1] = { x: endPos!.x, y: endPos!.y };

        this.state.isVerifying = true;
        try {
          const result = await verifyEdge(this.state.currentLevel, startId, endId);

          const connection: Connection = {
            from: startId,
            to: endId,
            curve: curvePoints,
            valid: result.valid,
            opacity: 0,
            glowIntensity: 0
          };

          this.state.connections.push(connection);
          this.animateConnection(connection);

          if (result.valid) {
            this.state.completedEdges.add(edgeKey);
            this.checkCompletion();
          } else {
            setTimeout(() => {
              this.removeConnection(startId, endId);
            }, 1500);
          }
        } finally {
          this.state.isVerifying = false;
        }
      } else {
        this.triggerShakeFeedback([startId, endId]);
      }
    }

    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
  }

  private animateConnection(conn: Connection): void {
    const duration = 600;
    const startTime = performance.now();

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = clamp(elapsed / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);

      conn.opacity = eased;
      conn.glowIntensity = eased;

      if (t < 1) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  private removeConnection(from: string, to: string): void {
    const idx = this.state.connections.findIndex(
      c => c.from === from && c.to === to
    );
    if (idx >= 0) {
      const conn = this.state.connections[idx];
      const duration = 400;
      const startOpacity = conn.opacity;
      const startTime = performance.now();

      const fadeOut = () => {
        const elapsed = performance.now() - startTime;
        const t = clamp(elapsed / duration, 0, 1);
        conn.opacity = startOpacity * (1 - t);

        if (t < 1) {
          requestAnimationFrame(fadeOut);
        } else {
          this.state.connections.splice(idx, 1);
        }
      };
      fadeOut();
    }
  }

  private checkCompletion(): void {
    if (!this.state.levelData) return;

    const total = this.state.levelData.edges.length;
    const current = this.state.completedEdges.size;

    this.onProgressChange?.(current, total);

    if (current >= total && !this.state.isComplete) {
      this.state.isComplete = true;
      if (this.completionTimeoutId) {
        clearTimeout(this.completionTimeoutId);
      }
      this.completionTimeoutId = setTimeout(() => {
        this.onComplete?.(this.state.levelData!.creatureDescription);
        this.completionTimeoutId = null;
      }, 1500);
    }
  }

  undoLastConnection(): void {
    if (this.state.connections.length === 0 || this.state.isComplete) return;

    const idx = this.state.connections.length - 1;
    const conn = this.state.connections[idx];

    if (conn.valid) {
      const edgeKey = [conn.from, conn.to].sort().join('-');
      this.state.completedEdges.delete(edgeKey);
      this.onProgressChange?.(this.state.completedEdges.size, this.state.levelData?.edges.length ?? 0);
    }

    const duration = 300;
    const startOpacity = conn.opacity;
    const startTime = performance.now();

    const fadeOut = () => {
      const elapsed = performance.now() - startTime;
      const t = clamp(elapsed / duration, 0, 1);
      conn.opacity = startOpacity * (1 - t);

      if (t < 1) {
        requestAnimationFrame(fadeOut);
      } else {
        this.state.connections.splice(idx, 1);
      }
    };
    fadeOut();
  }

  resetLevel(): void {
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    this.state.connections = [];
    this.state.completedEdges = new Set();
    this.state.isComplete = false;
    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
    this.state.keyboardFocusId = this.state.keyboardMode ? this.findClosestToCenterAnchor()?.id ?? null : null;
    this.state.keyboardStartId = null;
    this.state.keyboardPreviewLine = null;
    this.state.isVerifying = false;
    this.state.feedbackShake = null;
    this.onProgressChange?.(0, this.state.levelData?.edges.length ?? 0);
  }

  toggleFrequencies(): boolean {
    this.state.showFrequencies = !this.state.showFrequencies;
    return this.state.showFrequencies;
  }

  async loadLevel(levelId: number): Promise<boolean> {
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    const data = await getLevel(levelId);
    if (!data) return false;

    this.state.currentLevel = levelId;
    this.state.levelData = data;
    this.state.connections = [];
    this.state.completedEdges = new Set();
    this.state.isComplete = false;
    this.state.rotationOffset = 0;
    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
    this.state.showFrequencies = false;
    this.state.keyboardStartId = null;
    this.state.keyboardPreviewLine = null;
    this.state.isVerifying = false;
    this.state.feedbackShake = null;

    const mainAnchors = data.anchorPoints.filter(a =>
      a.id.startsWith('a') || a.id.startsWith('b') || a.id.startsWith('c')
    );
    if (mainAnchors.length > 0 && this.state.keyboardMode) {
      const center = this.renderer.getCenter();
      let nearest = mainAnchors[0];
      let nearestDist = Infinity;
      for (const anchor of mainAnchors) {
        const maxDim = Math.min(this.renderer['width'], this.renderer['height']) * 0.9;
        const relX = (anchor.x - 0.5) * maxDim;
        const relY = (anchor.y - 0.5) * maxDim;
        const pos = { x: center.x + relX, y: center.y + relY };
        const d = Math.sqrt((pos.x - center.x) ** 2 + (pos.y - center.y) ** 2);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = anchor;
        }
      }
      this.state.keyboardFocusId = nearest.id;
    }

    this.onLevelChange?.(data);
    this.onProgressChange?.(0, data.edges.length);

    return true;
  }

  getCurrentLevel(): number {
    return this.state.currentLevel;
  }

  start(): void {
    this.lastTime = performance.now();
    this.loop();
  }

  stop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  private loop(): void {
    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    try {
      this.update(delta);
      this.render();
    } catch (err) {
      console.error('Game loop error:', err);
    }

    this.animationFrameId = requestAnimationFrame(() => this.loop());
  }

  private update(delta: number): void {
    this.state.time += delta;

    if (this.state.levelData) {
      this.state.rotationOffset += this.state.levelData.rotationSpeed * delta * 60;
    }

    this.state.connections.forEach(c => {
      c.opacity = Math.min(c.opacity, 1);
    });

    if (this.state.feedbackShake) {
      const elapsed = performance.now() - this.state.feedbackShake.startTime;
      if (elapsed > 400) {
        this.state.feedbackShake = null;
      }
    }
  }

  private render(): void {
    this.renderer.beginFrame();

    if (this.state.levelData) {
      this.renderer.drawBackgroundStars(
        this.backgroundStars,
        this.state.rotationOffset,
        this.state.time
      );

      this.renderer.drawLightPollution(this.state.time, this.state.levelData.lightPollution);

      this.renderer.drawCreatureOutline(
        this.state.levelData.anchorPoints,
        this.state.levelData.edges,
        this.state.connections,
        this.state.rotationOffset,
        this.getProgress()
      );

      this.renderer.drawConnections(this.state.connections, this.state.time);

      if (this.state.drawState.isDrawing && this.state.drawState.startAnchorId) {
        const startAnchor = this.state.levelData.anchorPoints.find(
          a => a.id === this.state.drawState.startAnchorId
        );
        if (startAnchor && this.state.drawState.currentPos) {
          this.renderer.drawCurrentPath(
            this.state.drawState.points,
            startAnchor,
            this.state.drawState.currentPos,
            this.state.time,
            this.state.rotationOffset
          );
        }
      }

      if (this.state.keyboardPreviewLine && this.state.keyboardMode) {
        const fromAnchor = this.state.levelData.anchorPoints.find(
          a => a.id === this.state.keyboardPreviewLine!.from
        );
        const toAnchor = this.state.levelData.anchorPoints.find(
          a => a.id === this.state.keyboardPreviewLine!.to
        );
        if (fromAnchor && toAnchor) {
          this.renderer.drawKeyboardPreviewLine(
            fromAnchor,
            toAnchor,
            this.state.time,
            this.state.rotationOffset
          );
        }
      }

      const connectedIds = new Set<string>();
      this.state.connections.filter(c => c.valid).forEach(c => {
        connectedIds.add(c.from);
        connectedIds.add(c.to);
      });

      this.renderer.drawAnchorPoints(
        this.state.levelData.anchorPoints,
        this.state.rotationOffset,
        this.state.time,
        this.state.showFrequencies,
        this.state.snapTargetId ?? this.state.drawState.startAnchorId,
        connectedIds,
        this.state.keyboardMode,
        this.state.keyboardFocusId,
        this.state.keyboardStartId,
        this.state.feedbackShake,
        this.state.isVerifying
      );

      if (this.state.keyboardMode) {
        this.renderer.drawKeyboardModeIndicator(this.state.time, this.state.isVerifying);
      }

      this.renderer.drawCompletionEffect(this.state.time, this.getProgress());
    }
  }

  isKeyboardMode(): boolean {
    return this.state.keyboardMode;
  }

  private getProgress(): number {
    if (!this.state.levelData) return 0;
    const total = this.state.levelData.edges.length;
    if (total === 0) return 0;
    return this.state.completedEdges.size / total;
  }

  destroy(): void {
    this.stop();
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }
    this.listeners.forEach(fn => fn());
  }
}
