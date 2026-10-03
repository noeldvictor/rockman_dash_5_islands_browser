package com.nttdocomo.ui;

import rdash.Host;

public abstract class Canvas extends Frame {
    public static final int IME_COMMITTED = 0;
    public static final int IME_CANCELED = 1;

    private Graphics graphics;

    public Canvas() {
    }

    public Graphics getGraphics() {
        if (graphics == null) {
            graphics = new Graphics(Host.screen());
        }
        return graphics;
    }

    public abstract void paint(Graphics g);

    public void repaint() {
        Graphics g = getGraphics();
        g.lock();
        paint(g);
        g.unlock(true);
    }

    public void repaint(int x, int y, int w, int h) {
        repaint();
    }

    public void processEvent(int type, int param) {
    }

    public int getKeypadState() {
        return Host.keyState();
    }

    public int getKeypadState(int group) {
        return group == 0 ? Host.keyState() : 0;
    }
}
