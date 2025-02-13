(function (global) {
    'use strict';

    const DIRECTIVES = Object.freeze({
        'bind': 'vx-bind',
        'show': 'vx-show',
        'if': 'vx-if',
        'for': 'vx-for',
        'model': 'vx-model',
        'on': 'vx-on'
    });
    const compiledExpressions = new Map();

    function createReactiveProxy(target, callback, path = '') {
        const cache = new Map();

        return new Proxy(target, {
            get(target, property) {
                if (typeof property === 'symbol') {
                    return target[property];
                }

                const value = target[property];
                const newPath = path ? `${path}.${property}` : property;

                if (typeof value === 'object' && value !== null) {
                    if (!cache.has(property)) {
                        cache.set(property, createReactiveProxy(value, callback, newPath));
                    }
                    return cache.get(property);
                }
                return value;
            },
            set(target, property, value) {
                const oldValue = target[property];
                if (oldValue !== value) {
                    target[property] = value;
                    const newPath = path ? `${path}.${property}` : property;
                    callback(newPath);
                }
                return true;
            }
        });
    }

    /**
     * Clase VNode: Representa un nodo virtual para diffing del DOM.
     */
    class VNode {
        constructor(element) {
            this.tagName = element.tagName?.toLowerCase() || null;
            this.attributes = new Map(
                Array.from(element.attributes || []).map(attr => [attr.name, attr.value])
            );
            this.children = Array.from(element.childNodes).map(child =>
                child.nodeType === Node.TEXT_NODE ? child.textContent : new VNode(child)
            );
            this.key = element.getAttribute('key');
        }

        /**
         * Compara este nodo con otro VNode para detectar diferencias.
         * @param {VNode} oldNode - Nodo virtual anterior.
         * @returns {Object} Resultado del diffing con instrucciones de cambio.
         */
        diff(oldNode) {
            if (!oldNode) return { type: 'CREATE', node: this };
            if (!this.tagName) return { type: 'UPDATE_TEXT', text: this.children[0] };
            if (this.tagName !== oldNode.tagName) return { type: 'REPLACE', node: this };

            // Comparar atributos
            const attributeDiffs = this.diffAttributes(oldNode.attributes);

            // Comparar hijos
            const childrenDiffs = this.diffChildren(oldNode.children);

            // Si hay diferencias, devolver los cambios
            if (attributeDiffs.length > 0 || childrenDiffs.length > 0) {
                return {
                    type: 'UPDATE',
                    attributes: attributeDiffs,
                    children: childrenDiffs
                };
            }

            return { type: 'NONE' };
        }

        /**
         * Compara los atributos de este nodo con otro y devuelve los cambios.
         * @param {Map} oldAttributes - Atributos del nodo anterior.
         * @returns {Array} Cambios detectados en los atributos.
         */
        diffAttributes(oldAttributes) {
            const changes = [];

            // Verificar atributos nuevos o modificados
            for (const [key, value] of this.attributes.entries()) {
                if (!oldAttributes.has(key) || oldAttributes.get(key) !== value) {
                    changes.push({ type: 'SET_ATTR', key, value });
                }
            }

            // Verificar atributos eliminados
            for (const key of oldAttributes.keys()) {
                if (!this.attributes.has(key)) {
                    changes.push({ type: 'REMOVE_ATTR', key });
                }
            }

            return changes;
        }

        /**
         * Compara los hijos del nodo con los del nodo anterior.
         * @param {Array} oldChildren - Lista de hijos del nodo anterior.
         * @returns {Array} Diferencias en los hijos.
         */
        diffChildren(oldChildren) {
            const diffs = [];
            const oldMap = new Map();

            oldChildren.forEach((child, index) => {
                if (child.key) oldMap.set(child.key, { node: child, index });
            });

            this.children.forEach((newChild, index) => {
                const key = newChild.key ?? index;
                const old = oldMap.get(key);

                if (!old) {
                    diffs.push({ type: 'ADD_CHILD', index, node: newChild });
                } else {
                    oldMap.delete(key);
                    const childDiff = newChild.diff(old.node);
                    if (childDiff.type !== 'NONE') {
                        diffs.push({ type: 'UPDATE_CHILD', index, changes: childDiff });
                    }
                }
            });

            oldMap.forEach(({ index }) => {
                diffs.push({ type: 'REMOVE_CHILD', index });
            });

            return diffs;
        }

    }


    /**
     * Clase ErrorBoundary para gestionar errores en las directivas.
     */
    class ErrorBoundary {
        constructor() {
            this.errorHandlers = new Set();
        }

        handle(error, directiveType, element) {
            const errorInfo = {
                message: error.message,
                directive: directiveType,
                element: element,
                timestamp: new Date(),
                stack: error.stack
            };

            this.errorHandlers.forEach(handler => handler(errorInfo));
            console.error(`[VortexJS] ${directiveType} error:`, errorInfo);
        }

        onError(handler) {
            this.errorHandlers.add(handler);
            return () => this.errorHandlers.delete(handler);
        }
    }

    /**
     * Clase DirectiveManager:
     * Se encarga de registrar y procesar las directivas (vx-bind, vx-show, vx-if, vx-for, vx-model, vx-on).
     */
    class DirectiveManager {
        constructor(engine) {
            this.engine = engine;
            this.directives = new Map();
            this.templateCache = new WeakMap();
            this.registerDefaultDirectives();
        }

        compileExpression(expression, context = 'state') {
            const cacheKey = `${expression}:${context}`;
            if (!compiledExpressions.has(cacheKey)) {
                compiledExpressions.set(cacheKey, new Function(context, `with(${context}){ return ${expression}; }`));
            }
            return compiledExpressions.get(cacheKey);
        }

        registerDefaultDirectives() {
            // vx-bind: Enlaza una expresión al contenido textual del elemento.
            this.register('bind', (el, expression) => {
                const evaluate = this.compileExpression(expression);
                let lastValue;
                this.engine.bindings.push({
                    type: 'bind',
                    el,
                    evaluate,
                    update: (state) => {
                        const newValue = evaluate(state);
                        if (newValue !== lastValue) {
                            lastValue = newValue;
                            el.textContent = newValue;
                        }
                    }
                });
            });

            // vx-show: Controla la visibilidad del elemento.
            this.register('show', (el, expression) => {
                const evaluate = this.compileExpression(expression);
                this.engine.bindings.push({
                    type: 'show',
                    el,
                    evaluate,
                    update: (state) => {
                        const visible = evaluate(state);
                        el.style.display = visible ? '' : 'none';
                    }
                });
            });

            // vx-if: Inserta o remueve el elemento del DOM según la condición.
            this.register('if', (el, expression) => {
                const evaluate = this.compileExpression(expression);
                const parent = el.parentNode;
                const placeholder = document.createComment("vx-if placeholder");
                this.engine.bindings.push({
                    type: 'if',
                    el,
                    evaluate,
                    parent,
                    placeholder,
                    update: (state) => {
                        if (evaluate(state)) {
                            if (!el.parentNode) {
                                parent.replaceChild(el, placeholder);
                            }
                        } else {
                            if (el.parentNode) {
                                parent.replaceChild(placeholder, el);
                            }
                        }
                    }
                });
            });

            // vx-for: Itera sobre un array para generar elementos dinámicamente.
            this.register('for', (el, expression) => {
                const match = expression.match(/^\s*(\w+)\s+in\s+(\w+)\s*$/);
                if (!match) {
                    console.error(`VortexJS: vx-for tiene un formato incorrecto: "${expression}"`);
                    return;
                }
                const [_, itemName, listName] = match;
                const template = this.templateCache.get(el) || el.cloneNode(true);
                this.templateCache.set(el, template);
                const parent = el.parentNode;
                parent.removeChild(el);

                let previousElements = new Map();
                this.engine.bindings.push({
                    type: 'for',
                    listName,
                    itemName,
                    parent,
                    template,
                    update: (state) => {
                        const list = state[listName];
                        if (!Array.isArray(list)) return;

                        let newElements = new Map();
                        const fragment = document.createDocumentFragment();

                        list.forEach((item, index) => {
                            const key = item.key ?? index; // Usa 'key' si está presente
                            let element = previousElements.get(key);

                            if (!element) {
                                element = template.cloneNode(true);
                                this.processElement(element, item, state, itemName);
                            } else {
                                this.updateElement(element, item, state, itemName);
                            }

                            newElements.set(key, element);
                            fragment.appendChild(element);
                        });

                        // Remover elementos obsoletos
                        previousElements.forEach((el, key) => {
                            if (!newElements.has(key)) el.remove();
                        });

                        parent.appendChild(fragment);
                        previousElements = newElements;
                    }
                });
            });

            // vx-model: Enlace bidireccional para inputs.
            this.register('model', (el, expression) => {
                const modelName = expression.trim();
                const evaluate = this.compileExpression(modelName);

                const updateInput = (state) => {
                    const newValue = evaluate(state);
                    if (el.value !== newValue) {
                        el.value = newValue;
                    }
                };

                this.engine.bindings.push({
                    type: 'model',
                    el,
                    modelName,
                    evaluate,
                    update: updateInput
                });

                el.addEventListener("input", (e) => {
                    this.engine.setState({ [modelName]: e.target.value });
                });
            });


            // vx-on: Asocia manejadores de eventos al elemento.
            this.register('on', (el, expression) => {
                // Permite múltiples eventos separados por ";"
                const handlers = expression.split(";").map(s => s.trim()).filter(Boolean);
                handlers.forEach(handler => {
                    const [eventName, code] = handler.split(":").map(s => s.trim());
                    if (eventName && code) {
                        let fn;
                        try {
                            fn = new Function("state", "event", `with(state){ ${code}; }`);
                        } catch (error) {
                            console.error(`VortexJS: Error compilando vx-on para el evento "${eventName}": "${code}"`, error);
                            return;
                        }
                        el.addEventListener(eventName, event => {
                            fn(this.engine.state, event);
                        });
                    }
                });
            });

        }

        register(name, handler) {
            this.directives.set(name, handler);
        }

        processZone(zone) {
            // Para cada directiva, recorremos los elementos con ese atributo
            Object.keys(DIRECTIVES).forEach(key => {
                const attr = DIRECTIVES[key];
                // Evitamos procesar elementos que sean descendientes de un vx-for,
                // excepto el propio elemento que define el vx-for.
                zone.querySelectorAll(`[${attr}]`).forEach(el => {
                    if (el !== zone && el.closest('[vx-for]') && !el.hasAttribute('vx-for')) {
                        return;
                    }
                    const expression = el.getAttribute(attr);
                    const handler = this.directives.get(key);
                    if (handler) {
                        handler(el, expression);
                    }
                });
            });
        }

        setupDirectives(zone) {
            if (zone) {
                this.processZone(zone);
            } else {
                document.querySelectorAll("[vx-zone]").forEach(zoneEl => this.processZone(zoneEl));
            }
        }

        processElement(element, item, state, itemName) {
            const bindElements = element.querySelectorAll("[vx-bind]");
            bindElements.forEach(el => {
                const expr = el.getAttribute("vx-bind");
                const evaluate = this.compileExpression(expr, "state");
                const combinedState = Object.assign({}, state, { [itemName]: item });
                el.textContent = evaluate(combinedState);
            });
        }

        updateElement(element, item, state, itemName) {
            const bindElements = element.querySelectorAll("[vx-bind]");
            bindElements.forEach(el => {
                const expr = el.getAttribute("vx-bind");
                const evaluate = this.compileExpression(expr, "state");
                const combinedState = Object.assign({}, state, { [itemName]: item });
                const newValue = evaluate(combinedState);
                if (el.textContent !== newValue.toString()) {
                    el.textContent = newValue;
                }
            });
        }
    }

    /**
     * Clase VortexEngine: núcleo reactivo de VortexJS.
     * Gestiona el estado, actualizaciones y renderización de las directivas.
     */
    class VortexEngine {
        constructor(initialState = {}) {
            this.state = createReactiveProxy(initialState, (path) => this._scheduleUpdate(path));
            this.bindings = [];
            this.pendingUpdates = new Set();
            this.updateScheduled = false;
            this.errorBoundary = new ErrorBoundary();
            this.directiveManager = new DirectiveManager(this);
        }

        _scheduleUpdate(path) {
            this.pendingUpdates.add(path);
            if (!this.updateScheduled) {
                this.updateScheduled = true;
                requestAnimationFrame(() => {
                    this._processUpdates();
                });
            }
        }

        _processUpdates() {
            const affectedPaths = new Set(this.pendingUpdates);
            this.pendingUpdates.clear();
            this.updateScheduled = false;

            this.bindings.forEach(binding => {
                if (this._shouldUpdateBinding(binding, affectedPaths)) {
                    try {
                        if (binding.update) {
                            binding.update(this.state);
                        } else {
                            this._updateBinding(binding);
                        }
                    } catch (error) {
                        this.errorBoundary.handle(error, binding.type, binding.el);
                    }
                }
            });
        }

        _shouldUpdateBinding(binding, affectedPaths) {
            // Aquí se podría optimizar el chequeo según dependencias específicas.
            return true;
        }

        _render() {
            this.bindings.forEach(binding => {
                try {
                    if (binding.update) {
                        binding.update(this.state);
                    } else {
                        this._updateBinding(binding);
                    }
                } catch (error) {
                    this.errorBoundary.handle(error, binding.type, binding.el);
                }
            });
        }

        _updateBinding(binding) {
            if (binding.evaluate) {
                const newValue = binding.evaluate(this.state);
                binding.el.textContent = newValue;
            }
        }

        /**
         * Monta el engine procesando todas las zonas definidas con vx-zone.
         * @param {string} [selector="[vx-zone]"] - Selector para las zonas reactivas.
         * @returns {VortexEngine} Instancia del engine.
         */
        mount(selector = "[vx-zone]") {
            const zones = document.querySelectorAll(selector);
            zones.forEach(zone => {
                this.directiveManager.processZone(zone);
            });
            this._render();
            return this;
        }

        /**
         * Actualiza el estado y programa un renderizado optimizado (batching).
         * @param {object} newState - Propiedades a actualizar en el estado.
         */
        setState(newState) {
            Object.assign(this.state, newState);
            if (!this.updateScheduled) {
                this.updateScheduled = true;
                requestAnimationFrame(() => {
                    this._render();
                    this.updateScheduled = false;
                });
            }
        }
    }

    const VortexCore = {
        createEngine(initialState = {}) {
            return new VortexEngine(initialState);
        }
    };

    global.Vortex = VortexCore;
})(this);
