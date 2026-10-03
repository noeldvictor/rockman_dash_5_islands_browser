package com.nttdocomo.ui.graphics3d;

import rdash.Host;

public class Figure extends DrawableObject3D {
    private ActionTable action;

    Figure() {
        super(TYPE_FIGURE);
    }

    public void setTexture(Texture t) {
        Host.g3dFigureTextureCount(js, 1);
        Host.g3dFigureTexture(js, 0, t == null ? null : t.js);
    }

    public void setTextures(Texture[] t) {
        Host.g3dFigureTextureCount(js, t.length);
        for (int i = 0; i < t.length; i++) {
            Host.g3dFigureTexture(js, i, t[i] == null ? null : t[i].js);
        }
    }

    public void setAction(ActionTable action, int index) {
        this.action = action;
        Host.g3dFigureAction(js, action == null ? null : action.js, index);
    }

    public ActionTable getActionTable() {
        return action;
    }

    public int getNumPatterns() {
        return Host.g3dGetInt(js, "numPatterns");
    }

    public void setPattern(int pattern) {
        Host.g3dSetInt(js, "pattern", pattern);
    }
}
