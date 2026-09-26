CREATE TABLE "vector_installation_ownerships" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"installation_id" varchar(64) NOT NULL,
	"profile" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vector_installation_ownerships" ADD CONSTRAINT "vector_installation_ownerships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vector_installation_ownerships_installation_uq" ON "vector_installation_ownerships" USING btree ("installation_id");