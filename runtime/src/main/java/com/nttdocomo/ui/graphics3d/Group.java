package com.nttdocomo.ui.graphics3d;

import java.util.ArrayList;

import com.nttdocomo.ui.util3d.Transform;

import rdash.Host;

public class Group extends DrawableObject3D {
    private final ArrayList<Object3D> elements = new ArrayList<>();
    private final Transform transform = new Transform();

    public Group() {
        super(TYPE_GROUP);
        js = Host.g3dCreateGroup();
    }

    Group(int type) {
        super(type);
    }

    public int getNumElements() {
        return elements.size();
    }

    public Object3D getElement(int index) {
        return elements.get(index);
    }

    public void removeElement(int index) {
        elements.remove(index);
        Host.g3dGroupRemove(js, index);
    }

    public void addElement(Object3D o) {
        elements.add(o);
        Host.g3dGroupAdd(js, o.js);
    }

    public void setTransform(Transform t) {
        transform.set(t);
        Host.g3dGroupTransform(js, transform.m);
    }

    public void getTransform(Transform t) {
        t.set(transform);
    }
}
