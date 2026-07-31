using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebOcrServer.Migrations
{
    /// <inheritdoc />
    public partial class AddTextStyleProperties : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "FontColor",
                table: "PageTranslationLogs",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<float>(
                name: "Rotation",
                table: "PageTranslationLogs",
                type: "REAL",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "StrokeColor",
                table: "PageTranslationLogs",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "StrokeWidth",
                table: "PageTranslationLogs",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TextAlign",
                table: "PageTranslationLogs",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FontColor",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "Rotation",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "StrokeColor",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "StrokeWidth",
                table: "PageTranslationLogs");

            migrationBuilder.DropColumn(
                name: "TextAlign",
                table: "PageTranslationLogs");
        }
    }
}
