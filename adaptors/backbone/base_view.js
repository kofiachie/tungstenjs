/**
 * Base backbone view for vdom- see class declaration for more information
 *
 * @author    Matt DeGennaro <mdegennaro@wayfair.com>
 */
'use strict';
var _ = require('underscore');
var Backbone = require('backbone');
var tungsten = require('../../src/tungsten');
var logger = require('../../src/utils/logger');
var ViewWidget = require('./backbone_view_widget');

// Cached regex to split keys for `delegate`.
var delegateEventSplitter = /^(\S+)\s*(.*)$/;

/**
 * Provides generic reusable methods that child views can inherit from
 */
var BaseView = Backbone.View.extend({
  /*
   * Default to an empty hash
   */
  eventOptions: {},
  /**
   * Shared init logic
   */
  initialize: function(options) {
    if (!this.el) {
      return false;
    }

    this.options = options || {};

    // Pass router through options, setting router.view if not already set
    if (this.options.router) {
      this.router = this.options.router;
      this.router.view = this.router.view || this;
    }
    // Template object
    if (this.options.template) {
      this.compiledTemplate = this.options.template;
    }
    // VTree is passable as an option if we are transitioning in from a different view
    if (this.options.vtree) {
      this.vtree = this.options.vtree;
    }
    // First-pass rendering context
    if (this.options.context) {
      this.context = this.options.context;
    }
    // Handle to the parent view
    if (this.options.parentView) {
      this.parentView = this.options.parentView;
    }

    /* develblock:start */
    this.initDebug();
    /* develblock:end */

    var dataItem = this.serialize();

    // Sanity check that compiledTemplate exists and has a toVdom method
    if (this.compiledTemplate && this.compiledTemplate.toVdom) {
      // Run attachView with this instance to attach childView widget points
      this.compiledTemplate = this.compiledTemplate.attachView(this, ViewWidget);

      if (this.options.dynamicInitialize) {
        // If dynamicInitialize is set, empty this.el and replace it with the rendered template
        while (this.el.firstChild) {
          this.el.removeChild(this.el.firstChild);
        }
        var tagName = this.el.tagName;
        this.vtree = tungsten.parseString('<' + tagName + '></' + tagName + '>');
        this.render();
      }

      // If the deferRender option was set, it means a layout manager / a module will control when this view is rendered
      if (!this.options.deferRender) {
        var self = this;
        self.vtree = self.vtree || self.compiledTemplate.toVdom(dataItem, true);
        self.initializeRenderListener(dataItem);
        if (!this.options.dynamicInitialize) {
          self.validateVdom();
        }
        if (this.options.dynamicInitialize) {
          // If dynamicInitialize was set, render was already invoked, so childViews are attached
          self.postInitialize();
        } else {
          setTimeout(function() {
            self.attachChildViews();
            self.postInitialize();
          }, 1);
        }
      } else {
        this.initializeRenderListener(dataItem);
        this.postInitialize();
      }
    } else {
      this.initializeRenderListener(dataItem);
      this.postInitialize();
    }
  },
  tungstenViewInstance: true,
  debouncer: null,
  initializeRenderListener: function(dataItem) {
    // If this has a model and is the top level view, set up the listener for rendering
    if (dataItem && (dataItem.tungstenModel || dataItem.tungstenCollection)) {
      var runOnChange;
      var self = this;
      if (!this.parentView) {
        runOnChange = _.bind(this.render, this);
      } else if (!dataItem.parentProp && this.parentView.model !== dataItem) {
        // If this model was not set up via relation, manually trigger an event on the parent's model to kick one off
        runOnChange = function() {
          // trigger event on parent to start a render
          self.parentView.model.trigger('render');
        };
      }
      if (runOnChange) {
        this.listenTo(dataItem, 'all', function() {
          // Since we're attaching a very naive listener, we may get many events in sequence, so we set a small debounce
          clearTimeout(self.debouncer);
          self.debouncer = setTimeout(runOnChange, 1);
        });
      }
    }
  },

  /**
   * This function is run once we are done initializing the view.
   * Currently unimplemented. Child views should override this if they would like to use it.
   */
  postInitialize: function() {},

  validateVdom: function() {
    var isText = function(node) {
      return typeof node === 'string' || node.type === 'VirtualText';
    };

    // If there's a mismatch in childNode counts, it's usually extra whitespace from the server
    // We can trim those off so that the VTree is unaffected during lookups
    // Since this is in the form of whitespace around the template, it's a simple type check on the first and last node
    if (this.vtree.children.length !== this.el.childNodes.length) {
      // If the first part of the template is a string or the first node isn't a textNode, assume that's fine
      if (!isText(this.vtree.children[0]) && this.el.childNodes[0] && this.el.childNodes[0].nodeType === 3) {
        this.el.removeChild(this.el.childNodes[0]);
      }
      // If the last part of the template is a string or the last node isn't a textNode, assume that's fine
      var lastNode = this.el.childNodes[this.el.childNodes.length - 1];
      if (!isText(this.vtree.children[this.vtree.children.length - 1]) && lastNode && lastNode.nodeType === 3) {
        this.el.removeChild(lastNode);
      }
    }
    /* develblock:start */
    // Compare full template against full DOM
    var diff = this.getTemplateDiff();
    if (diff.indexOf('<ins>') + diff.indexOf('<del>') > -2) {
      console.warn('DOM does not match VDOM. Use debug panel to see differences');
    }
    /* develblock:end */
  },

  /* develblock:start */
  initDebug: function() {
    tungsten.debug.registry.register(this);
    _.bindAll(this, 'getEvents', 'isParent', 'getDebugName', 'getChildViews');
  },
  getEventFunction: function(selector) {
    var events = _.result(this, 'events');
    return this[events[selector]];
  },
  getFunctions: function(trackedFunctions, getTrackableFunction) {
    var result = [];
    // Debug functions shouldn't be debuggable
    var blacklist = {
      constructor: true,
      initialize: true,
      postInitialize: true,
      initDebug: true,
      getEventFunction: true,
      getFunctions: true,
      getEvents: true,
      getElTemplate: true,
      getVdomTemplate: true,
      isParent: true,
      getChildren: true,
      getDebugTag: true,
      getDebugName: true
    };
    for (var key in this) {
      if (typeof this[key] === 'function' && blacklist[key] !== true) {
        result.push({
          name: key,
          fn: this[key],
          inherited: (key in BaseView.prototype)
        });
        this[key] = getTrackableFunction(this, key, trackedFunctions);
      }
    }
    return result;
  },
  getEvents: function() {
    var events = _.result(this, 'events');
    var eventKeys = _.keys(events);

    var result = new Array(eventKeys.length);
    for (var i = 0; i < eventKeys.length; i++) {
      result[i] = {
        selector: eventKeys[i],
        tracked: false,
        fn: events[eventKeys[i]]
      };
    }
    return result;
  },
  getTemplateDiff: function() {
    if (!this.parentView) {
      var numChildren = Math.max(this.vtree.children.length, this.el.childNodes.length);
      var output = '';
      for (var i = 0; i < numChildren; i++) {
        output += tungsten.debug.diffVtreeAndElem(this.vtree.children[i], this.el.childNodes[i]);
      }
      return output;
    } else {
      return tungsten.debug.diffVtreeAndElem(this.vtree, this.el);
    }
  },
  getVdomTemplate: function(recursive) {
    var vtreeToRender = this.vtree;
    if (!this.parentView) {
      vtreeToRender = vtreeToRender.children;
    }
    return tungsten.debug.vtreeToString(vtreeToRender, true, recursive);
  },

  isParent: function() {
    var children = this.getChildren();
    return children.length > 0;
  },

  getChildren: function() {
    return this.constructor.prototype.getChildViews.call(this);
  },

  getDebugTag: function() {
    var name = this.getDebugName();
    return '<span class="js-view-list-item clickable-property" data-id="' + name + '">[' + name + ']</span>';
  },

  getDebugName: function() {
    return this.constructor.debugName ? this.constructor.debugName + this.cid.replace('view', '') : this.cid;
  },
  /* develblock:end */

  /**
   * Lets the child view dictate what to pass into the template as context. If not overriden, then it will simply use the default
   * model.attributes or collection.toJSON
   *
   * @return {Object} model.attributes or collection.toJSON()
   */
  serialize: function() {
    return this.model || this.collection || {};
  },

  /**
   * Override of the base Backbone function
   * @param  {Object?} events  Event object o bind to. Falls back to this.events
   */
  delegateEvents: function(events) {
    if (!this.el) {
      return;
    }
    if (!(events || (events = _.result(this, 'events')))) {
      return;
    }
    var self = this;
    setTimeout(function() {
      // Unbind any current events
      self.undelegateEvents();
      // Get any options that may  have been set
      var eventOptions = _.result(self, 'eventOptions');
      // Event / selector strings
      var keys = _.keys(events);
      var key;
      // Create an array to hold the information to detach events
      self.eventsToRemove = new Array(keys.length);
      for (var i = keys.length; i--;) {
        key = keys[i];
        // Sanity check that value maps to a function
        var method = events[key];
        if (!_.isFunction(method)) {
          method = self[events[key]];
        }
        if (!method) {
          throw new Error('Method "' + events[key] + '" does not exist');
        }
        var match = key.match(delegateEventSplitter);
        var eventName = match[1],
          selector = match[2];
        method = _.bind(method, self);

        // throws an error if invalid
        self.eventsToRemove[i] = tungsten.bindEvent(self.el, eventName, selector, method, eventOptions[key]);
      }
    }, 1);
  },

  /**
   * Override of the base Backbone function
   */
  undelegateEvents: function() {
    if (!this.el) {
      return;
    }
    // Uses array created in delegateEvents to unbind events
    if (this.eventsToRemove) {
      for (var i = 0; i < this.eventsToRemove.length; i++) {
        tungsten.unbindEvent(this.eventsToRemove[i]);
      }
      this.eventsToRemove = null;
    }
  },

  /**
   * Generic view rendering function that renders the view's compiled template using its model
   * @return {Object} the view itself for chainability
   */
  render: function() {
    if (!this.compiledTemplate) {
      return;
    }

    // let the view have a say in what context to pass to the template
    // defaults to an empty object for context so that our view render won't fail
    var serializedModel = this.context || this.serialize();
    var initialTree = this.vtree || this.compiledTemplate.toVdom(this.serialize(), true);
    this.vtree = tungsten.updateTree(this.el, initialTree, this.compiledTemplate.toVdom(serializedModel));

    // Clear any passed context
    this.context = null;

    // good to know when the view is rendered
    this.trigger('rendered');
    this.postRender();

    return this;
  },

  /**
   * This function is run once we are done rendering the view.
   * Currently unimplemented. Child views should override this if they would like to use it.
   */
  postRender: function() {},

  /**
   * Updates the function with a new model and template
   * @param  {Object}  newModel     Model to update to
   */
  update: function(newModel) {
    // Track if anything has changed in order to trigger a render
    if (newModel !== this.model) {
      // If the model has changed, change listener to new model
      this.stopListening(this.model);
      this.model = newModel;
      this.initializeRenderListener(newModel);
    }
    this.render();
  },

  /**
   * Parse this.vtree for childViews
   * This ensures DOM order and only gets the list on demand rather than each render cycle
   * @return {Array<Object>} DOM order array of child views
   */
  getChildViews: function() {
    var childInstances = [];

    var recurse = function(vnode) {
      var child;
      for (var i = 0; i < vnode.children.length; i++) {
        child = vnode.children[i];
        if (child.type === 'VirtualNode' && child.hasWidgets) {
          recurse(child);
        } else if (child.type === 'Widget' && child.view) {
          childInstances.push(child.view);
        }
      }
    };
    recurse(this.vtree);

    return childInstances;
  },

  /**
   * Parse this.vtree for childViews and attach them to the DOM node
   * Used during initialization where a render is unnecessary
   */
  attachChildViews: function() {
    var recurse = function(vnode, elem) {
      if (!elem) {
        return;
      }
      var child;
      for (var i = 0; i < vnode.children.length; i++) {
        child = vnode.children[i];
        if (child.type === 'VirtualNode' && child.hasWidgets) {
          recurse(child, elem.childNodes[i]);
        } else if (child.type === 'Widget' && !child.view && typeof child.attach === 'function') {
          child.attach(elem.childNodes[i]);
        }
      }
    };
    recurse(this.vtree, this.el);
  },

  /**
   * Removes model listeners and DOM events from this and all child views
   */
  destroy: function() {
    clearTimeout(this.debouncer);
    this.stopListening();
    this.undelegateEvents();
    var childInstances = this.getChildViews();
    for (var i = 0; i < childInstances.length; i++) {
      childInstances[i].destroy();
    }
  }
}, {
  tungstenView: true,
  extend: function(protoProps, staticProps) {
    var methods = ['initialize', 'render', 'delegateEvents', 'undelegateEvents'];
    for (var i = 0; i < methods.length; i++) {
      if (typeof protoProps[methods[i]] === 'function') {
        logger.warn('View.' + methods[i] + ' may not be overridden');
      }
    }

    return Backbone.View.extend.call(this, protoProps, staticProps);
  }
});

module.exports = BaseView;
