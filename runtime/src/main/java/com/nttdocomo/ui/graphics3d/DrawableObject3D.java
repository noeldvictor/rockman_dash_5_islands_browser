package com.nttdocomo.ui.graphics3d;

import com.nttdocomo.ui.util3d.Transform;

import rdash.Host;

public abstract class DrawableObject3D extends Object3D {
    public static final int BLEND_NORMAL = 0;
    public static final int BLEND_ALPHA = 32;
    public static final int BLEND_ADD = 64;

    DrawableObject3D() {
    }

    DrawableObject3D(int type) {
        super(type);
    }

    public boolean isCross(DrawableObject3D other, Transform a, Transform b) {
        return false;
    }

    public void setPerspectiveCorrectionEnabled(boolean enabled) {
    }

    public void setBlendMode(int mode) {
        Host.g3dSetInt(js, "blendMode", mode);
    }

    public void setTransparency(float t) {
        Host.g3dSetFloat(js, "transparency", t);
    }
}
