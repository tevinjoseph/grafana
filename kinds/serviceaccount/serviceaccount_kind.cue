package kind

name:     "Serviceaccount"
maturity: "merged"

lineage: seqs: [
	{
		schemas: [
			// v0.0
			{
				// ID is the unique identifier of the service account in the database.
				id: int64 @grafanamaturity(ToMetadata="sys")
				// OrgID is the ID of an organisation the service account belongs to.
				orgID: int64 @grafanamaturity(ToMetadata="sys")
				// Name of the service account.
				name: string
				// Login of the service account.
				login: string
				// IsDisabled indicates if the service account is disabled.
				isDisabled: bool
				// Role is the Grafana organization role of the service account which can be 'Viewer', 'Editor', 'Admin'.
				role: #OrgRole @grafanamaturity(ToMetadata="kind")
				// Tokens is the number of active tokens for the service account.
				// Tokens are used to authenticate the service account against Grafana.
				tokens: int64 @grafanamaturity(ToMetadata="sys")
				// AvatarUrl is the service account's avatar URL. It allows the frontend to display a picture in front
				// of the service account.
				avatarUrl: string @grafanamaturity(ToMetadata="sys")
				// AccessControl metadata associated with a given resource.
				accessControl?: {
					[string]: bool @grafanamaturity(ToMetadata="sys")
				}

				// OrgRole is a Grafana Organization Role which can be 'Viewer', 'Editor', 'Admin'.
				#OrgRole: "Admin" | "Editor" | "Viewer" @cuetsy(kind="type")
			},
		]
	},
]
