package com.nttdocomo.ui;

import org.teavm.jso.JSObject;

import rdash.Host;

public abstract class Image {
    JSObject js;

    Image() {
    }

    public static Image createImage(int width, int height) {
        return new HostImage(Host.createImage(width, height));
    }

    public Graphics getGraphics() {
        return new Graphics(Host.imageGraphics(js));
    }

    public int getWidth() {
        return Host.imageWidth(js);
    }

    public int getHeight() {
        return Host.imageHeight(js);
    }

    public void dispose() {
        if (js != null) {
            Host.imageDispose(js);
            js = null;
        }
    }

    public void setAlpha(int alpha) {
    }

    static final class HostImage extends Image {
        HostImage(JSObject js) {
            this.js = js;
        }
    }
}
