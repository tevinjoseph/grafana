package migrations

import (
	"context"
	"fmt"

	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/services/sqlstore/migrator"
	"github.com/grafana/grafana/pkg/services/sqlstore/session"
	entityDB "github.com/grafana/grafana/pkg/services/store/entity/db"
	"github.com/grafana/grafana/pkg/setting"
)

func MigrateEntityStore(db entityDB.EntityDB, features featuremgmt.FeatureToggles) error {
	// Skip if feature flag is not enabled
	if !features.IsEnabled(featuremgmt.FlagEntityStore) {
		return nil
	}

	// !!! This should not run in production!
	// The object store SQL schema is still in active development and this
	// will only be called when the feature toggle is enabled
	// this check should not be necessary, but is added as an extra check
	if setting.Env == setting.Prod {
		return nil
	}

	mg := migrator.NewScopedMigrator(db.GetEngine(), db.GetCfg(), "entity")
	mg.AddCreateMigration()

	marker := initEntityTables(mg)

	// While this feature is under development, we can completly wipe and recreate
	// The initial plan is to keep the source of truth in existing SQL tables, and mirrot it
	// to a kubernetes model.  Once the kubernetes model needs to be preserved,
	// this code should be removed
	exists, err := db.GetEngine().IsTableExist("entity_migration_log")
	if err != nil {
		return err
	}
	if exists {
		log, err := mg.GetMigrationLog()
		if err != nil {
			return err
		}
		_, found := log[marker]
		if !found && len(log) > 0 {
			// Remove the migration log (and potential other orphan tables)
			tables := []string{"entity_migration_log"}

			ctx := context.Background()
			err = db.GetSession().WithTransaction(ctx, func(tx *session.SessionTx) error {
				for _, t := range tables {
					_, err := tx.Exec(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", t))
					if err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				return err
			}

			// remove old entries from in-memory log
			for id := range log {
				mg.RemoveMigrationLogs(id)
			}
		}
	}

	return mg.Start(
		features.IsEnabled(featuremgmt.FlagMigrationLocking),
		0)
}
