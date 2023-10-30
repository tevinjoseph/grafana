// SPDX-License-Identifier: AGPL-3.0-only
// Provenance-includes-location: https://github.com/kubernetes-sigs/apiserver-runtime/blob/main/pkg/experimental/storage/filepath/jsonfile_rest.go
// Provenance-includes-license: Apache-2.0
// Provenance-includes-copyright: The Kubernetes Authors.

package grafanaapiserver

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/conversion"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/apiserver/pkg/storage"
	"k8s.io/apiserver/pkg/storage/storagebackend"
	"k8s.io/apiserver/pkg/storage/storagebackend/factory"

	"github.com/grafana/grafana/pkg/services/store/entity"
	"github.com/grafana/grafana/pkg/util"
)

var _ storage.Interface = (*Storage)(nil)

const MaxUpdateAttempts = 1

// Storage implements storage.Interface and storage resources as JSON files on disk.
type Storage struct {
	config       *storagebackend.ConfigForResource
	store        entity.EntityStoreServer
	gr           schema.GroupResource
	codec        runtime.Codec
	keyFunc      func(obj runtime.Object) (string, error)
	newFunc      func() runtime.Object
	newListFunc  func() runtime.Object
	getAttrsFunc storage.AttrFunc
	// trigger      storage.IndexerFuncs
	// indexers     *cache.Indexers

	// watchSet *WatchSet
}

// ErrFileNotExists means the file doesn't actually exist.
var ErrFileNotExists = fmt.Errorf("file doesn't exist")

// ErrNamespaceNotExists means the directory for the namespace doesn't actually exist.
var ErrNamespaceNotExists = errors.New("namespace does not exist")

func NewStorage(
	config *storagebackend.ConfigForResource,
	gr schema.GroupResource,
	store entity.EntityStoreServer,
	codec runtime.Codec,
	keyFunc func(obj runtime.Object) (string, error),
	newFunc func() runtime.Object,
	newListFunc func() runtime.Object,
	getAttrsFunc storage.AttrFunc,
) (storage.Interface, factory.DestroyFunc, error) {
	return &Storage{
		config:       config,
		gr:           gr,
		codec:        codec,
		store:        store,
		keyFunc:      keyFunc,
		newFunc:      newFunc,
		newListFunc:  newListFunc,
		getAttrsFunc: getAttrsFunc,
	}, nil, nil
}

// Create adds a new object at a key unless it already exists. 'ttl' is time-to-live
// in seconds (0 means forever). If no error is returned and out is not nil, out will be
// set to the read value from database.
func (s *Storage) Create(ctx context.Context, key string, obj runtime.Object, out runtime.Object, ttl uint64) error {
	ctx, err := contextWithFakeGrafanaUser(ctx)
	if err != nil {
		return err
	}

	fmt.Printf("k8s CREATE: %#v\n\n%#v\n\n%#v\n\n", key, obj, out)

	if err := s.Versioner().PrepareObjectForStorage(obj); err != nil {
		return err
	}

	metaAccessor, err := meta.Accessor(obj)
	if err != nil {
		return err
	}

	// Replace the default name generation strategy
	if metaAccessor.GetGenerateName() != "" {
		k, err := ParseKey(key)
		if err != nil {
			return err
		}
		k.Name = util.GenerateShortUID()
		key = k.String()

		metaAccessor.SetName(k.Name)
		metaAccessor.SetGenerateName("")
	}

	e, err := resourceToEntity(key, obj)
	if err != nil {
		return err
	}

	req := &entity.WriteEntityRequest{
		Entity: e,
	}

	fmt.Printf("req: %#v\n\n", req)

	rsp, err := s.store.Write(ctx, req)
	if err != nil {
		return err
	}
	if rsp.Status != entity.WriteEntityResponse_CREATED {
		return fmt.Errorf("this was not a create operation... (%s)", rsp.Status.String())
	}

	err = entityToResource(rsp.Entity, out)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	/*
		s.watchSet.notifyWatchers(watch.Event{
			Object: out.DeepCopyObject(),
			Type:   watch.Added,
		})
	*/

	fmt.Printf("k8s CREATE:%#v\n", out)
	return nil
}

// Delete removes the specified key and returns the value that existed at that spot.
// If key didn't exist, it will return NotFound storage error.
// If 'cachedExistingObject' is non-nil, it can be used as a suggestion about the
// current version of the object to avoid read operation from storage to get it.
// However, the implementations have to retry in case suggestion is stale.
func (s *Storage) Delete(
	ctx context.Context, key string, out runtime.Object, preconditions *storage.Preconditions,
	validateDeletion storage.ValidateObjectFunc, cachedExistingObject runtime.Object) error {
	ctx, err := contextWithFakeGrafanaUser(ctx)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	grn, err := keyToGRN(key, out.GetObjectKind().GroupVersionKind().Kind)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	previousVersion := ""
	if preconditions != nil && preconditions.ResourceVersion != nil {
		previousVersion = *preconditions.ResourceVersion
	}

	rsp, err := s.store.Delete(ctx, &entity.DeleteEntityRequest{
		GRN:             grn,
		PreviousVersion: previousVersion,
	})
	if err != nil {
		return err
	}

	err = entityToResource(rsp.Entity, out)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	fmt.Printf("k8s DELETE:%#v\n", out)
	return nil
}

// Watch begins watching the specified key. Events are decoded into API objects,
// and any items selected by 'p' are sent down to returned watch.Interface.
// resourceVersion may be used to specify what version to begin watching,
// which should be the current resourceVersion, and no longer rv+1
// (e.g. reconnecting without missing any updates).
// If resource version is "0", this interface will get current object at given key
// and send it in an "ADDED" event, before watch starts.
func (s *Storage) Watch(ctx context.Context, key string, opts storage.ListOptions) (watch.Interface, error) {
	return nil, apierrors.NewMethodNotSupported(schema.GroupResource{}, "watch")
}

// Get unmarshals object found at key into objPtr. On a not found error, will either
// return a zero object of the requested type, or an error, depending on 'opts.ignoreNotFound'.
// Treats empty responses and nil response nodes exactly like a not found error.
// The returned contents may be delayed, but it is guaranteed that they will
// match 'opts.ResourceVersion' according 'opts.ResourceVersionMatch'.
func (s *Storage) Get(ctx context.Context, key string, opts storage.GetOptions, objPtr runtime.Object) error {
	ctx, err := contextWithFakeGrafanaUser(ctx)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	rsp, err := s.store.Read(ctx, &entity.ReadEntityRequest{
		Key:         key,
		WithMeta:    true,
		WithBody:    true,
		WithStatus:  true,
		WithSummary: true,
	})
	if err != nil {
		return err
	}

	if rsp.GRN == nil {
		if opts.IgnoreNotFound {
			return nil
		}

		return apierrors.NewNotFound(s.gr, key)
	}

	err = entityToResource(rsp, objPtr)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	fmt.Printf("k8s GET:%#v\n\n", objPtr)
	return nil
}

// GetList unmarshalls objects found at key into a *List api object (an object
// that satisfies runtime.IsList definition).
// If 'opts.Recursive' is false, 'key' is used as an exact match. If `opts.Recursive'
// is true, 'key' is used as a prefix.
// The returned contents may be delayed, but it is guaranteed that they will
// match 'opts.ResourceVersion' according 'opts.ResourceVersionMatch'.
func (s *Storage) GetList(ctx context.Context, key string, opts storage.ListOptions, listObj runtime.Object) error {
	ctx, err := contextWithFakeGrafanaUser(ctx)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	k := key // s.newFunc().GetObjectKind()

	fmt.Printf("kind: %#v\n", k)

	listPtr, err := meta.GetItemsPtr(listObj)
	if err != nil {
		return err
	}
	v, err := conversion.EnforcePtr(listPtr)
	if err != nil {
		return err
	}

	rsp, err := s.store.Search(ctx, &entity.EntitySearchRequest{
		// Kind:     []string{s.newFunc().GetObjectKind().GroupVersionKind().Kind},
		Key:      []string{k},
		WithBody: true,
	})
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	for _, r := range rsp.Results {
		res := s.newFunc()

		err := entityToResource(r, res)
		if err != nil {
			return apierrors.NewInternalError(err)
		}

		v.Set(reflect.Append(v, reflect.ValueOf(res).Elem()))
	}

	listAccessor, err := meta.ListAccessor(listObj)
	if err != nil {
		return err
	}

	if rsp.NextPageToken != "" {
		listAccessor.SetContinue(rsp.NextPageToken)
		fmt.Printf("CONTINUE: %s\n", rsp.NextPageToken)
	}

	fmt.Printf("k8s GETLIST: %#v\n\n", listObj)
	return nil
}

// GuaranteedUpdate keeps calling 'tryUpdate()' to update key 'key' (of type 'destination')
// retrying the update until success if there is index conflict.
// Note that object passed to tryUpdate may change across invocations of tryUpdate() if
// other writers are simultaneously updating it, so tryUpdate() needs to take into account
// the current contents of the object when deciding how the update object should look.
// If the key doesn't exist, it will return NotFound storage error if ignoreNotFound=false
// else `destination` will be set to the zero value of it's type.
// If the eventual successful invocation of `tryUpdate` returns an output with the same serialized
// contents as the input, it won't perform any update, but instead set `destination` to an object with those
// contents.
// If 'cachedExistingObject' is non-nil, it can be used as a suggestion about the
// current version of the object to avoid read operation from storage to get it.
// However, the implementations have to retry in case suggestion is stale.
func (s *Storage) GuaranteedUpdate(
	ctx context.Context,
	key string,
	destination runtime.Object,
	ignoreNotFound bool,
	preconditions *storage.Preconditions,
	tryUpdate storage.UpdateFunc,
	cachedExistingObject runtime.Object,
) error {
	// ctx, err := contextWithFakeGrafanaUser(ctx)
	// if err != nil {
	// 	return err
	// }
	var err error
	for attempt := 1; attempt <= MaxUpdateAttempts; attempt = attempt + 1 {
		err = s.guaranteedUpdate(ctx, key, destination, ignoreNotFound, preconditions, tryUpdate, cachedExistingObject)
		if err == nil {
			return nil
		}
	}

	return err
}

func (s *Storage) guaranteedUpdate(
	ctx context.Context,
	key string,
	destination runtime.Object,
	ignoreNotFound bool,
	preconditions *storage.Preconditions,
	tryUpdate storage.UpdateFunc,
	cachedExistingObject runtime.Object,
) error {
	ctx, err := contextWithFakeGrafanaUser(ctx)
	if err != nil {
		return err
	}

	err = s.Get(ctx, key, storage.GetOptions{}, destination)
	if err != nil {
		return err
	}

	res := &storage.ResponseMeta{}
	updatedObj, _, err := tryUpdate(destination, *res)
	if err != nil {
		fmt.Printf("tryUpdate error: %s\n", err.Error())
		var statusErr *apierrors.StatusError
		if errors.As(err, &statusErr) {
			// For now, forbidden may come from a mutation handler
			if statusErr.ErrStatus.Reason == metav1.StatusReasonForbidden {
				return statusErr
			}
		}

		return apierrors.NewInternalError(fmt.Errorf("could not successfully update object of type=%s, key=%s, err=%s", destination.GetObjectKind(), key, err.Error()))
	}

	e, err := resourceToEntity(key, updatedObj)
	if err != nil {
		return err
	}

	e.GRN.ResourceKind = destination.GetObjectKind().GroupVersionKind().Kind

	previousVersion := ""
	if preconditions != nil && preconditions.ResourceVersion != nil {
		previousVersion = *preconditions.ResourceVersion
	}

	req := &entity.WriteEntityRequest{
		Entity:          e,
		PreviousVersion: previousVersion,
	}

	fmt.Printf("req: %#v\n", req)

	rsp, err := s.store.Write(ctx, req)
	if err != nil {
		return err // continue???
	}

	if rsp.Status == entity.WriteEntityResponse_UNCHANGED {
		return nil // destination is already set
	}

	err = entityToResource(rsp.Entity, destination)
	if err != nil {
		return apierrors.NewInternalError(err)
	}

	/*
		s.watchSet.notifyWatchers(watch.Event{
			Object: destination.DeepCopyObject(),
			Type:   watch.Modified,
		})
	*/

	return nil
}

// Count returns number of different entries under the key (generally being path prefix).
func (s *Storage) Count(key string) (int64, error) {
	return 0, nil
}

func (s *Storage) Versioner() storage.Versioner {
	return &storage.APIObjectVersioner{}
}

func (s *Storage) RequestWatchProgress(ctx context.Context) error {
	return nil
}
