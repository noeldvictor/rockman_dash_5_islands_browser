package com.nttdocomo.ui.graphics3d;

import rdash.Host;

public class ActionTable extends Object3D {
    ActionTable() {
        super(TYPE_ACTION_TABLE);
    }

    public int getNumActions() {
        return Host.g3dGetInt(js, "numActions");
    }

    public int getMaxFrame(int action) {
        return Host.g3dMaxFrame(js, action);
    }
}
